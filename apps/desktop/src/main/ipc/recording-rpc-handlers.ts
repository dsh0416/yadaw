import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, isResourceRef, rpcFailure, rpcSuccess } from "@yadaw/contracts"
import type {
  RecordingStartRequest,
  RecordingResourceSnapshot,
  ResourceRef,
  RpcError,
  RpcRequestMeta,
  RpcResult,
  WaveformWindowRequest
} from "@yadaw/contracts"
import type { BeginOperationResult } from "../kernel/operation-registry"
import type { IpcHandlerContext } from "./context"
import { registerRpcHandler } from "./rpc"
import { validateWaveformRequest } from "./support"

function sameRef(left: ResourceRef | undefined | null, right: ResourceRef | undefined | null) {
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    left.id === right.id &&
    left.epoch === right.epoch &&
    left.generation === right.generation
  )
}

function error(
  meta: RpcRequestMeta,
  kind: "validation" | "conflict" | "stale" | "busy" | "unavailable" | "quarantined",
  activeOperationId?: string,
  actualRevision?: number
): RpcError {
  const common = {
    correlationId: randomUUID(),
    ...(meta.target ? { resource: meta.target } : {})
  }
  if (kind === "validation") {
    return {
      code: "validation-failed",
      category: "validation",
      outcome: "not-committed",
      retry: "never",
      userMessageKey: "errors.invalidRpcRequest",
      details: { type: "validation-failed", field: "recording" },
      ...common
    }
  }
  if (kind === "conflict") {
    return {
      code: "revision-conflict",
      category: "conflict",
      outcome: "not-committed",
      retry: "after-reconcile",
      userMessageKey: "errors.revisionConflict",
      details: {
        type: "revision-conflict",
        expectedRevision: meta.expectedRevision ?? -1,
        actualRevision: actualRevision ?? -1
      },
      ...common
    }
  }
  if (kind === "stale") {
    return {
      code: "stale-resource",
      category: "stale-resource",
      outcome: "not-committed",
      retry: "after-reconcile",
      userMessageKey: "errors.staleResource",
      details: { type: "stale-resource", reason: "generation-mismatch" },
      ...common
    }
  }
  if (kind === "busy") {
    return {
      code: "resource-busy",
      category: "busy",
      outcome: "not-committed",
      retry: "safe",
      userMessageKey: "errors.resourceBusy",
      details: { type: "resource-busy", activeOperationId },
      ...common
    }
  }
  if (kind === "quarantined") {
    return {
      code: "invariant-violation",
      category: "invariant-violation",
      outcome: "quarantined",
      retry: "after-reconcile",
      userMessageKey: "errors.recordingMediaRecoverable",
      details: { type: "invariant-violation", component: "main" },
      ...common
    }
  }
  return {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    userMessageKey: "errors.recordingUnavailable",
    details: { type: "resource-unavailable", component: "main", dispatched: true },
    ...common
  }
}

function rebind(meta: RpcRequestMeta, result: RpcResult<unknown>): RpcResult<unknown> {
  return { ...structuredClone(result), requestId: meta.requestId }
}

function replay(meta: RpcRequestMeta, context: IpcHandlerContext): RpcResult<unknown> | null {
  const operationId = meta.mutation?.operationId
  if (!operationId) return null
  const existing = context.operations.registry.status(operationId)
  if (!existing.ok) return null
  return existing.value.result
    ? rebind(meta, existing.value.result)
    : rpcFailure(meta, error(meta, "busy", existing.value.operationId))
}

function begin(
  meta: RpcRequestMeta,
  target: ResourceRef,
  context: IpcHandlerContext
): BeginOperationResult | RpcResult<never> {
  const mutation = meta.mutation!
  const result = context.operations.registry.begin({
    operationId: mutation.operationId,
    idempotencyKey: mutation.idempotencyKey,
    target
  })
  if (!result.ok) return rpcFailure(meta, error(meta, "busy", mutation.operationId))
  return result.value
}

function isRpcResult(value: BeginOperationResult | RpcResult<never>): value is RpcResult<never> {
  return "ok" in value
}

function recordingStartRequest(value: unknown): RecordingStartRequest | null {
  if (!value || typeof value !== "object") return null
  const request = value as Partial<RecordingStartRequest>
  return isResourceRef(request.project) &&
    request.project.kind === "project-session" &&
    isResourceRef(request.projectGraph) &&
    request.projectGraph.kind === "project-graph" &&
    isResourceRef(request.audioEngine) &&
    request.audioEngine.kind === "audio-engine"
    ? (request as RecordingStartRequest)
    : null
}

export function registerRecordingRpcHandlers(context: IpcHandlerContext): void {
  const { recordings, projects, projectGraph, lifecycle, operations } = context
  const commitProjectProjection = async () => {
    const session = projects.current
    if (!session) throw new Error("project-workspace-unavailable")
    return lifecycle.applicationState.commitWorkspaceProjection(
      session,
      await projectGraph.snapshot(),
      await projects.listAssets()
    )
  }

  registerRpcHandler(IPC_CHANNELS.recordingStart, async ({ meta }, value: unknown) => {
    if (!meta.mutation) return rpcFailure(meta, error(meta, "validation"))
    const previous = replay(meta, context)
    if (previous) return previous
    const request = recordingStartRequest(value)
    const state = lifecycle.applicationState
    const workspace = state.workspaceSnapshot()
    const audio = state.audioResourceSnapshot()
    if (
      !request ||
      !workspace ||
      !sameRef(meta.target, workspace.project) ||
      !sameRef(request.project, workspace.project) ||
      !sameRef(request.projectGraph, workspace.projectGraph) ||
      !sameRef(request.audioEngine, audio.engine)
    ) {
      return rpcFailure(meta, error(meta, request ? "stale" : "validation"))
    }
    if (meta.expectedRevision !== workspace.revision) {
      return rpcFailure(meta, error(meta, "conflict", undefined, workspace.revision))
    }
    const operation = begin(meta, workspace.project, context)
    if (isRpcResult(operation)) return operation
    if (operation.disposition !== "started") {
      const existing = operation.operation
      return existing.result
        ? rebind(meta, existing.result)
        : rpcFailure(meta, error(meta, "busy", existing.operationId))
    }
    let committedResource: RecordingResourceSnapshot | null = null
    try {
      lifecycle.beginRecordingStart()
      const session = await recordings.start()
      const resource = state.commitRecording(session, request)
      committedResource = resource
      lifecycle.completeRecordingStart(session)
      const result = rpcSuccess(meta, resource, { resourceRevision: resource.revision })
      operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch (reason) {
      await recordings.abortStart().catch(() => undefined)
      if (committedResource) {
        await state.dropRecording()
      }
      lifecycle.failRecordingStart(reason)
      const result = rpcFailure(
        meta,
        error(meta, committedResource ? "quarantined" : "unavailable")
      )
      operations.registry.finish(
        meta.mutation.operationId,
        committedResource ? "quarantined" : "not-committed",
        result
      )
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.recordingStop, async ({ meta }) => {
    if (!meta.mutation) return rpcFailure(meta, error(meta, "validation"))
    const replayed = replay(meta, context)
    if (replayed) return replayed
    const state = lifecycle.applicationState
    const current = state.recordingResourceSnapshot()
    if (!current || !sameRef(meta.target, current.recording)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    if (meta.expectedRevision !== current.revision) {
      return rpcFailure(meta, error(meta, "conflict", undefined, current.revision))
    }
    const operation = begin(meta, current.recording, context)
    if (isRpcResult(operation)) return operation
    if (operation.disposition !== "started") {
      const existing = operation.operation
      return existing.result
        ? rebind(meta, existing.result)
        : rpcFailure(meta, error(meta, "busy", existing.operationId))
    }
    try {
      const session = lifecycle.beginRecordingStop()
      const completed = await recordings.stop(() => lifecycle.markRecordingFinalizing(session))
      const workspace = await commitProjectProjection()
      await state.dropRecording()
      lifecycle.completeRecordingStop()
      lifecycle.syncProject(projects.current)
      const result = rpcSuccess(meta, {
        recording: current.recording,
        pending: completed,
        recoverableMedia: true,
        workspace
      })
      operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch (reason) {
      await state.dropRecording()
      lifecycle.failRecordingStop(reason)
      const result = rpcFailure(meta, error(meta, "quarantined"))
      operations.registry.finish(meta.mutation.operationId, "quarantined", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.recordingPendingList, async ({ meta }) => {
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace || !sameRef(meta.target, workspace.project)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    return rpcSuccess(meta, await recordings.listPending(), {
      resourceRevision: workspace.revision
    })
  })

  registerRpcHandler(IPC_CHANNELS.recordingRecover, async ({ meta }, value: unknown) => {
    if (!meta.mutation || typeof value !== "string" || value.length === 0) {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const replayed = replay(meta, context)
    if (replayed) return replayed
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace || !sameRef(meta.target, workspace.project)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    if (meta.expectedRevision !== workspace.revision) {
      return rpcFailure(meta, error(meta, "conflict", undefined, workspace.revision))
    }
    const operation = begin(meta, workspace.project, context)
    if (isRpcResult(operation)) return operation
    if (operation.disposition !== "started") {
      const existing = operation.operation
      return existing.result
        ? rebind(meta, existing.result)
        : rpcFailure(meta, error(meta, "busy", existing.operationId))
    }
    let persistentCommit = false
    try {
      lifecycle.beginRecordingRecovery(value)
      const recovered = await recordings.recover(value)
      persistentCommit = true
      const workspace = await commitProjectProjection()
      lifecycle.completeRecordingRecovery()
      lifecycle.syncProject(projects.current)
      const result = rpcSuccess(meta, { pending: recovered, workspace })
      operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch (reason) {
      lifecycle.failRecordingRecovery(reason)
      const result = rpcFailure(meta, error(meta, persistentCommit ? "quarantined" : "unavailable"))
      operations.registry.finish(
        meta.mutation.operationId,
        persistentCommit ? "quarantined" : "not-committed",
        result
      )
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.recordingDeletePending, async ({ meta }, value: unknown) => {
    if (!meta.mutation || typeof value !== "string" || value.length === 0) {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const workspace = lifecycle.applicationState.workspaceSnapshot()
    if (!workspace || !sameRef(meta.target, workspace.project)) {
      return rpcFailure(meta, error(meta, "stale"))
    }
    if (meta.expectedRevision !== workspace.revision) {
      return rpcFailure(meta, error(meta, "conflict", undefined, workspace.revision))
    }
    const operation = begin(meta, workspace.project, context)
    if (isRpcResult(operation)) return operation
    if (operation.disposition !== "started") {
      const existing = operation.operation
      return existing.result
        ? rebind(meta, existing.result)
        : rpcFailure(meta, error(meta, "busy", existing.operationId))
    }
    try {
      lifecycle.assertRecordingIdle()
      await recordings.deletePending(value)
      const result = rpcSuccess(meta, undefined)
      operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, error(meta, "unavailable"))
      operations.registry.finish(meta.mutation.operationId, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(
    IPC_CHANNELS.recordingWaveformSnapshot,
    async ({ meta }, value: WaveformWindowRequest) => {
      const current = lifecycle.applicationState.recordingResourceSnapshot()
      if (!current || !sameRef(meta.target, current.recording)) {
        return rpcFailure(meta, error(meta, "stale"))
      }
      try {
        return rpcSuccess(meta, await recordings.waveformSnapshot(validateWaveformRequest(value)))
      } catch {
        return rpcFailure(meta, error(meta, "unavailable"))
      }
    }
  )
}

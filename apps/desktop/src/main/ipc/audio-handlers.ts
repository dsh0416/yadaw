import { randomUUID } from "node:crypto"
import { ipcMain } from "electron"
import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@yadaw/contracts"
import type { ResourceRef, RpcError, RpcRequestMeta, RpcResult } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { registerRpcHandler } from "./rpc"
import {
  assertTrustedSender,
  normalizeAudioDeviceList,
  normalizeAudioRuntime,
  validateAudioBackend,
  validateAudioPreferences,
  validateRoundTripLatencyMeasurementRequest
} from "./support"

function sameRef(left: ResourceRef | undefined, right: ResourceRef | null): boolean {
  return Boolean(
    right &&
    left?.kind === right.kind &&
    left.id === right.id &&
    left.epoch === right.epoch &&
    left.generation === right.generation
  )
}

function failure(
  meta: RpcRequestMeta,
  code: "validation-failed" | "stale-resource" | "resource-unavailable",
  component: "main" | "audio-host" = "main"
): RpcError {
  if (code === "validation-failed") {
    return {
      code,
      category: "validation",
      outcome: "not-committed",
      retry: "never",
      correlationId: randomUUID(),
      userMessageKey: "errors.invalidRpcRequest",
      ...(meta.target ? { resource: meta.target } : {}),
      details: { type: code, field: "mutation" }
    }
  }
  if (code === "stale-resource") {
    return {
      code,
      category: "stale-resource",
      outcome: "not-committed",
      retry: "after-reconcile",
      correlationId: randomUUID(),
      userMessageKey: "errors.staleResource",
      ...(meta.target ? { resource: meta.target } : {}),
      details: { type: code, reason: "generation-mismatch" }
    }
  }
  return {
    code,
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey: "errors.audioEngineUnavailable",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: code, component, dispatched: true }
  }
}

function operationBusy(meta: RpcRequestMeta, activeOperationId: string): RpcError {
  return {
    code: "resource-busy",
    category: "busy",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey: "errors.resourceBusy",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "resource-busy", activeOperationId }
  }
}

function rebindResult(meta: RpcRequestMeta, result: RpcResult<unknown>): RpcResult<unknown> {
  return {
    ...structuredClone(result),
    requestId: meta.requestId
  }
}

function replayOperation(
  context: IpcHandlerContext,
  meta: RpcRequestMeta
): RpcResult<unknown> | null {
  const operationId = meta.mutation?.operationId
  if (!operationId) return null
  const existing = context.operations.registry.status(operationId)
  if (!existing.ok) return null
  return existing.value.result
    ? rebindResult(meta, existing.value.result)
    : rpcFailure(meta, operationBusy(meta, existing.value.operationId))
}

export function registerAudioHandlers(context: IpcHandlerContext): void {
  const {
    audioHost: audioHostService,
    projects,
    projectGraph,
    lifecycle,
    operations,
    isShuttingDown
  } = context
  ipcMain.handle(IPC_CHANNELS.audioBackends, async (event) => {
    assertTrustedSender(event)
    return audioHostService.listAudioBackends()
  })

  ipcMain.handle(IPC_CHANNELS.audioDevices, async (event, value: unknown) => {
    assertTrustedSender(event)
    return normalizeAudioDeviceList(
      await audioHostService.listAudioDevices(validateAudioBackend(value))
    )
  })

  registerRpcHandler(IPC_CHANNELS.audioStart, async ({ meta }, value: unknown) => {
    const state = lifecycle.applicationState
    if (!meta.mutation) return rpcFailure(meta, failure(meta, "validation-failed"))
    const replay = replayOperation(context, meta)
    if (replay) return replay
    const helperEpoch = audioHostService.helperEpoch()
    if (helperEpoch) await state.reconcileAudioHost(helperEpoch)
    if (!sameRef(meta.target, state.audioHost)) {
      return rpcFailure(meta, failure(meta, "stale-resource"))
    }
    const begun = operations.registry.begin({
      operationId: meta.mutation.operationId,
      idempotencyKey: meta.mutation.idempotencyKey,
      target: state.audioHost
    })
    if (!begun.ok) return rpcFailure(meta, failure(meta, "validation-failed"))
    if (begun.value.disposition !== "started") {
      return begun.value.operation.result
        ? rebindResult(meta, begun.value.operation.result)
        : rpcFailure(meta, operationBusy(meta, begun.value.operation.operationId))
    }
    try {
      const transition =
        lifecycle.snapshot().audio.status === "running" ? "reconfiguring" : "starting"
      lifecycle.beginAudio(transition)
      const runtime = normalizeAudioRuntime(
        await audioHostService.startAudioEngine(validateAudioPreferences(value))
      )
      const resources = await state.commitAudioEngine(runtime)
      lifecycle.completeAudio(runtime)
      const warnings = []
      if (projects.current) {
        try {
          await projectGraph.load()
        } catch {
          warnings.push({
            code: "project-graph-deployment-failed",
            userMessageKey: "warnings.audio.projectGraphDeploymentFailed",
            resource: resources.engine!
          })
        }
      }
      const result = rpcSuccess(
        meta,
        {
          ...resources,
          engine: resources.engine!,
          transport: resources.transport!,
          runtime
        },
        { warnings }
      )
      operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch (error) {
      const runtime = await audioHostService
        .audioEngineSnapshot()
        .catch(() => lifecycle.snapshot().audio.runtime)
      lifecycle.failAudio(error, normalizeAudioRuntime(runtime))
      const result = rpcFailure(meta, failure(meta, "resource-unavailable", "audio-host"))
      operations.registry.finish(meta.mutation.operationId, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.audioStop, async ({ meta }) => {
    const state = lifecycle.applicationState
    if (!meta.mutation) return rpcFailure(meta, failure(meta, "validation-failed"))
    const replay = replayOperation(context, meta)
    if (replay) return replay
    const helperEpoch = audioHostService.helperEpoch()
    if (helperEpoch) await state.reconcileAudioHost(helperEpoch)
    const current = state.audioResourceSnapshot()
    if (!sameRef(meta.target, current.engine)) {
      return rpcFailure(meta, failure(meta, "stale-resource"))
    }
    const begun = operations.registry.begin({
      operationId: meta.mutation.operationId,
      idempotencyKey: meta.mutation.idempotencyKey,
      target: current.engine!
    })
    if (!begun.ok) return rpcFailure(meta, failure(meta, "validation-failed"))
    if (begun.value.disposition !== "started") {
      return begun.value.operation.result
        ? rebindResult(meta, begun.value.operation.result)
        : rpcFailure(meta, operationBusy(meta, begun.value.operation.operationId))
    }
    try {
      lifecycle.beginAudio("stopping")
      const runtime = normalizeAudioRuntime(await audioHostService.stopAudioEngine())
      const resources = await state.dropAudioEngine()
      lifecycle.completeAudio(runtime)
      const result = rpcSuccess(meta, { ...resources, engine: null, transport: null, runtime })
      operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch (error) {
      const runtime = await audioHostService
        .audioEngineSnapshot()
        .catch(() => lifecycle.snapshot().audio.runtime)
      if (runtime.state === "stopped") {
        const resources = await state.dropAudioEngine()
        const normalized = normalizeAudioRuntime(runtime)
        lifecycle.completeAudio(normalized)
        const result = rpcSuccess(meta, {
          ...resources,
          engine: null,
          transport: null,
          runtime: normalized
        })
        operations.registry.finish(meta.mutation.operationId, "committed", result)
        return result
      }
      lifecycle.failAudio(error, normalizeAudioRuntime(runtime))
      const result = rpcFailure(meta, failure(meta, "resource-unavailable", "audio-host"))
      operations.registry.finish(meta.mutation.operationId, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.audioSnapshot, async ({ meta }) => {
    const state = lifecycle.applicationState
    const helperEpoch = audioHostService.helperEpoch()
    if (helperEpoch) await state.reconcileAudioHost(helperEpoch)
    const current = state.audioResourceSnapshot()
    if (!sameRef(meta.target, current.engine)) {
      return rpcFailure(meta, failure(meta, "stale-resource"))
    }
    if (isShuttingDown()) return lifecycle.snapshot().audio.runtime
    const snapshot = normalizeAudioRuntime(await audioHostService.audioEngineSnapshot())
    lifecycle.refreshAudio(snapshot)
    return snapshot
  })

  ipcMain.handle(IPC_CHANNELS.audioRoundTripLatencyStart, async (event, value: unknown) => {
    assertTrustedSender(event)
    return audioHostService.startRoundTripLatencyMeasurement(
      validateRoundTripLatencyMeasurementRequest(value)
    )
  })

  ipcMain.handle(IPC_CHANNELS.audioRoundTripLatencySnapshot, async (event) => {
    assertTrustedSender(event)
    return audioHostService.roundTripLatencyMeasurementSnapshot()
  })
}

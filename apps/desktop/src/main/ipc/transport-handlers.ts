import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@heron/contracts"
import type {
  ResourceRef,
  RpcError,
  RpcRequestMeta,
  RpcResult,
  TransportCommand
} from "@heron/contracts"
import type { IpcHandlerContext } from "./context"
import { reconcileAudioHostEpoch } from "./audio-host-reconcile"
import { registerRpcHandler } from "./rpc"

function sameRef(left: ResourceRef | undefined, right: ResourceRef | null): boolean {
  return Boolean(
    right &&
    left?.kind === right.kind &&
    left.id === right.id &&
    left.epoch === right.epoch &&
    left.generation === right.generation
  )
}

function isTransportCommand(value: unknown): value is TransportCommand {
  if (!value || typeof value !== "object") return false
  const command = value as Record<string, unknown>
  if (["play", "record", "pause", "record-count-in", "stop"].includes(String(command.type))) {
    return true
  }
  if (command.type === "seek") {
    return (
      typeof command.positionFrames === "number" &&
      Number.isSafeInteger(command.positionFrames) &&
      command.positionFrames >= 0
    )
  }
  if (command.type !== "set-loop" || typeof command.enabled !== "boolean") return false
  if (command.range === null) return true
  if (!command.range || typeof command.range !== "object") return false
  const range = command.range as Record<string, unknown>
  return (
    typeof range.startTick === "number" &&
    Number.isSafeInteger(range.startTick) &&
    range.startTick >= 0 &&
    typeof range.endTick === "number" &&
    Number.isSafeInteger(range.endTick) &&
    range.endTick > range.startTick
  )
}

function error(
  meta: RpcRequestMeta,
  category: "validation" | "stale-resource" | "conflict",
  actualRevision = 0
): RpcError {
  const resource = meta.target
  if (category === "validation") {
    return {
      code: "validation-failed",
      category,
      outcome: "not-committed",
      retry: "never",
      correlationId: randomUUID(),
      userMessageKey: "errors.invalidRpcRequest",
      ...(resource ? { resource } : {}),
      details: { type: "validation-failed", field: "transportCommand" }
    }
  }
  if (category === "conflict") {
    return {
      code: "revision-conflict",
      category,
      outcome: "not-committed",
      retry: "after-reconcile",
      correlationId: randomUUID(),
      userMessageKey: "errors.revisionConflict",
      ...(resource ? { resource } : {}),
      details: {
        type: "revision-conflict",
        expectedRevision: meta.expectedRevision ?? -1,
        actualRevision
      }
    }
  }
  return {
    code: "stale-resource",
    category,
    outcome: "not-committed",
    retry: "after-reconcile",
    correlationId: randomUUID(),
    userMessageKey: "errors.staleResource",
    ...(resource ? { resource } : {}),
    details: { type: "stale-resource", reason: "generation-mismatch" }
  }
}

function unknownOutcome(meta: RpcRequestMeta): RpcError {
  return {
    code: "operation-timeout-unknown",
    category: "timeout-unknown",
    outcome: "unknown",
    retry: "after-reconcile",
    correlationId: randomUUID(),
    userMessageKey: "errors.operationOutcomeUnknown",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "operation-timeout-unknown", dispatched: true }
  }
}

function busy(meta: RpcRequestMeta, activeOperationId: string): RpcError {
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

export function registerTransportHandlers(context: IpcHandlerContext): void {
  const { lifecycle, transport, operations, audioHost, recordings, isShuttingDown } = context
  const reconcileAudioHost = () =>
    reconcileAudioHostEpoch({
      audioHost,
      lifecycle,
      recordings
    })
  registerRpcHandler(IPC_CHANNELS.transportCommand, async ({ meta }, value: unknown) => {
    const state = lifecycle.applicationState
    if (!meta.mutation || meta.expectedRevision === undefined || !isTransportCommand(value)) {
      return rpcFailure(meta, error(meta, "validation"))
    }
    const existing = operations.registry.status(meta.mutation.operationId)
    if (existing.ok) {
      return existing.value.result
        ? rebindResult(meta, existing.value.result)
        : rpcFailure(meta, busy(meta, existing.value.operationId))
    }
    await reconcileAudioHost()
    const resources = state.audioResourceSnapshot()
    if (!sameRef(meta.target, resources.transport)) {
      return rpcFailure(meta, error(meta, "stale-resource"))
    }
    const begun = operations.registry.begin({
      operationId: meta.mutation.operationId,
      idempotencyKey: meta.mutation.idempotencyKey,
      target: resources.transport!
    })
    if (!begun.ok) return rpcFailure(meta, error(meta, "validation"))
    if (begun.value.disposition !== "started") {
      return begun.value.operation.result
        ? rebindResult(meta, begun.value.operation.result)
        : rpcFailure(meta, busy(meta, begun.value.operation.operationId))
    }
    if (meta.expectedRevision !== resources.revision) {
      const result = rpcFailure(meta, error(meta, "conflict", resources.revision))
      operations.registry.finish(meta.mutation.operationId, "not-committed", result)
      return result
    }
    try {
      const command = value
      try {
        lifecycle.assertTransportAllowed(command)
      } catch {
        const result = rpcFailure(meta, error(meta, "validation"))
        operations.registry.finish(meta.mutation.operationId, "not-committed", result)
        return result
      }
      const snapshot = isShuttingDown()
        ? {
            state: "stopped" as const,
            positionFrames: 0,
            sampleRate: lifecycle.snapshot().audio.runtime.sampleRate ?? 0,
            loopEnabled: false,
            loopRange: null
          }
        : await transport.command(command)
      const revision = state.advanceTransport(meta.expectedRevision, snapshot)
      const result = rpcSuccess(meta, snapshot, { resourceRevision: revision })
      operations.registry.finish(meta.mutation.operationId, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, unknownOutcome(meta))
      operations.registry.finish(meta.mutation.operationId, "quarantined", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.transportSnapshot, async ({ meta }) => {
    const state = lifecycle.applicationState
    await reconcileAudioHost()
    const resources = state.audioResourceSnapshot()
    if (!sameRef(meta.target, resources.transport)) {
      return rpcFailure(meta, error(meta, "stale-resource"))
    }
    if (isShuttingDown()) {
      return rpcSuccess(
        meta,
        {
          state: "stopped" as const,
          positionFrames: 0,
          sampleRate: lifecycle.snapshot().audio.runtime.sampleRate ?? 0,
          loopEnabled: false,
          loopRange: null
        },
        { resourceRevision: resources.revision }
      )
    }
    return rpcSuccess(meta, await transport.snapshot(), {
      resourceRevision: resources.revision
    })
  })
}

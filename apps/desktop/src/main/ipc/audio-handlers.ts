import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@heron/contracts"
import type { ResourceRef, RpcError, RpcRequestMeta } from "@heron/contracts"
import type { IpcHandlerContext } from "./context"
import { reconcileAudioHostEpoch } from "./audio-host-reconcile"
import { beginGuardedMutation, finishGuardedMutation } from "./operation-guard"
import { registerRpcHandler } from "./rpc"
import { validateMutationTarget, validateReadTarget } from "./resource-validation"
import {
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

export function registerAudioHandlers(context: IpcHandlerContext): void {
  const {
    audioHost: audioHostService,
    projects,
    projectGraph,
    lifecycle,
    recordings,
    isShuttingDown
  } = context
  const reconcileAudioHost = () =>
    reconcileAudioHostEpoch({
      audioHost: audioHostService,
      lifecycle,
      recordings
    })
  registerRpcHandler(IPC_CHANNELS.audioBackends, async ({ meta }) => {
    await reconcileAudioHost()
    const invalid = validateReadTarget(meta, lifecycle.applicationState.audioHost)
    if (invalid) return invalid
    return audioHostService.listAudioBackends()
  })

  registerRpcHandler(IPC_CHANNELS.audioDevices, async ({ meta }, value: unknown) => {
    await reconcileAudioHost()
    const invalid = validateReadTarget(meta, lifecycle.applicationState.audioHost)
    if (invalid) return invalid
    return normalizeAudioDeviceList(
      await audioHostService.listAudioDevices(validateAudioBackend(value))
    )
  })

  registerRpcHandler(IPC_CHANNELS.audioStart, async ({ meta }, value: unknown) => {
    const state = lifecycle.applicationState
    if (!meta.mutation) return rpcFailure(meta, failure(meta, "validation-failed"))
    await reconcileAudioHost()
    if (!sameRef(meta.target, state.audioHost)) {
      return rpcFailure(meta, failure(meta, "stale-resource"))
    }
    const guarded = beginGuardedMutation(context, meta, state.audioHost)
    if (guarded) return guarded
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
      finishGuardedMutation(context, meta, "committed", result)
      return result
    } catch (error) {
      const runtime = await audioHostService
        .audioEngineSnapshot()
        .catch(() => lifecycle.snapshot().audio.runtime)
      lifecycle.failAudio(error, normalizeAudioRuntime(runtime))
      const result = rpcFailure(meta, failure(meta, "resource-unavailable", "audio-host"))
      finishGuardedMutation(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.audioStop, async ({ meta }) => {
    const state = lifecycle.applicationState
    if (!meta.mutation) return rpcFailure(meta, failure(meta, "validation-failed"))
    await reconcileAudioHost()
    const current = state.audioResourceSnapshot()
    if (!sameRef(meta.target, current.engine)) {
      return rpcFailure(meta, failure(meta, "stale-resource"))
    }
    const guarded = beginGuardedMutation(context, meta, current.engine!)
    if (guarded) return guarded
    try {
      lifecycle.beginAudio("stopping")
      const runtime = normalizeAudioRuntime(await audioHostService.stopAudioEngine())
      const resources = await state.dropAudioEngine()
      lifecycle.completeAudio(runtime)
      const result = rpcSuccess(meta, { ...resources, engine: null, transport: null, runtime })
      finishGuardedMutation(context, meta, "committed", result)
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
        finishGuardedMutation(context, meta, "committed", result)
        return result
      }
      lifecycle.failAudio(error, normalizeAudioRuntime(runtime))
      const result = rpcFailure(meta, failure(meta, "resource-unavailable", "audio-host"))
      finishGuardedMutation(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.audioSnapshot, async ({ meta }) => {
    const state = lifecycle.applicationState
    await reconcileAudioHost()
    const current = state.audioResourceSnapshot()
    if (!sameRef(meta.target, current.engine)) {
      return rpcFailure(meta, failure(meta, "stale-resource"))
    }
    if (isShuttingDown()) return lifecycle.snapshot().audio.runtime
    const snapshot = normalizeAudioRuntime(await audioHostService.audioEngineSnapshot())
    lifecycle.refreshAudio(snapshot)
    return snapshot
  })

  registerRpcHandler(IPC_CHANNELS.audioRoundTripLatencyStart, async ({ meta }, value: unknown) => {
    await reconcileAudioHost()
    const target = lifecycle.applicationState.audioHost
    const invalid = validateMutationTarget(meta, target)
    if (invalid) return invalid
    const guarded = beginGuardedMutation(context, meta, target)
    if (guarded) return guarded
    try {
      const valueResult = await audioHostService.startRoundTripLatencyMeasurement(
        validateRoundTripLatencyMeasurementRequest(value)
      )
      const result = rpcSuccess(meta, valueResult)
      finishGuardedMutation(context, meta, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, failure(meta, "resource-unavailable", "audio-host"))
      finishGuardedMutation(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.audioRoundTripLatencySnapshot, async ({ meta }) => {
    await reconcileAudioHost()
    const invalid = validateReadTarget(meta, lifecycle.applicationState.audioHost)
    if (invalid) return invalid
    return audioHostService.roundTripLatencyMeasurementSnapshot()
  })
}

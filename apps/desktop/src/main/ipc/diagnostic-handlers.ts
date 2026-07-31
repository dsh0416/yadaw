import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, rpcFailure, rpcSuccess } from "@yadaw/contracts"
import type { RpcError, RpcRequestMeta } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { createAudioBenchmarkReport } from "../audio-benchmark-service"
import { reconcileAudioHostEpoch } from "./audio-host-reconcile"
import { beginGuardedMutation, finishGuardedMutation } from "./operation-guard"
import { registerRpcHandler } from "./rpc"
import {
  staleResourceFailure,
  validateMutationTarget,
  validateReadTarget
} from "./resource-validation"

function unavailable(meta: RpcRequestMeta, component: "main" | "audio-host"): RpcError {
  return {
    code: "resource-unavailable",
    category: "unavailable",
    outcome: "not-committed",
    retry: "safe",
    correlationId: randomUUID(),
    userMessageKey:
      component === "audio-host" ? "errors.audioEngineUnavailable" : "errors.operationFailed",
    ...(meta.target ? { resource: meta.target } : {}),
    details: { type: "resource-unavailable", component, dispatched: false }
  }
}

export function registerDiagnosticHandlers(context: IpcHandlerContext): void {
  const {
    lifecycle,
    projects,
    plugins,
    audioHost: audioHostService,
    sampleSystemPerformance,
    recordings
  } = context
  const state = lifecycle.applicationState
  const reconcileAudioHost = () =>
    reconcileAudioHostEpoch({
      audioHost: audioHostService,
      lifecycle,
      recordings
    })
  registerRpcHandler(IPC_CHANNELS.lifecycleSnapshot, ({ meta }) => {
    const invalid = validateReadTarget(meta, state.desktopSession)
    if (invalid) return invalid
    return lifecycle.snapshot()
  })

  registerRpcHandler(IPC_CHANNELS.systemPerformanceSnapshot, ({ meta }) => {
    const invalid = validateReadTarget(meta, state.desktopSession)
    if (invalid) return invalid
    return sampleSystemPerformance()
  })

  registerRpcHandler(IPC_CHANNELS.audioBenchmarkRun, async ({ meta }) => {
    await reconcileAudioHost()
    const invalid = validateMutationTarget(meta, state.audioHost)
    if (invalid) return invalid
    const guarded = beginGuardedMutation(context, meta, state.audioHost)
    if (guarded) return guarded
    try {
      const benchmarkEffect = plugins
        .list()
        .plugins.find(
          (plugin) => plugin.source.kind === "builtin" && plugin.source.id === "dev.yadaw.gain"
        )
      if (!benchmarkEffect) {
        const result = rpcFailure(meta, unavailable(meta, "main"))
        finishGuardedMutation(context, meta, "not-committed", result)
        return result
      }
      const result = rpcSuccess(
        meta,
        await createAudioBenchmarkReport(audioHostService, benchmarkEffect)
      )
      finishGuardedMutation(context, meta, "committed", result)
      return result
    } catch {
      const result = rpcFailure(meta, unavailable(meta, "audio-host"))
      finishGuardedMutation(context, meta, "not-committed", result)
      return result
    }
  })

  registerRpcHandler(IPC_CHANNELS.compiledAudioGraphSnapshot, ({ meta }) => {
    const workspace = state.workspaceSnapshot()
    if (!projects.current || !workspace) {
      return meta.target ? staleResourceFailure(meta, meta.target) : null
    }
    const invalid = validateReadTarget(meta, workspace.projectGraph)
    if (invalid) return invalid
    return audioHostService.compiledAudioGraphSnapshot()
  })
}

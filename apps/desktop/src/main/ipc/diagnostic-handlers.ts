import { IPC_CHANNELS, rpcSuccess } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { createAudioBenchmarkReport } from "../audio-benchmark-service"
import { registerRpcHandler } from "./rpc"
import {
  staleResourceFailure,
  validateMutationTarget,
  validateReadTarget
} from "./resource-validation"

export function registerDiagnosticHandlers(context: IpcHandlerContext): void {
  const {
    lifecycle,
    projects,
    plugins,
    audioHost: audioHostService,
    sampleSystemPerformance,
    operations
  } = context
  const state = lifecycle.applicationState
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
    const invalid = validateMutationTarget(meta, state.audioHost)
    if (invalid) return invalid
    const begun = operations.registry.begin({
      operationId: meta.mutation!.operationId,
      idempotencyKey: meta.mutation!.idempotencyKey,
      target: state.audioHost
    })
    if (!begun.ok) throw new Error(begun.error.code)
    if (begun.value.disposition !== "started" && begun.value.operation.result) {
      return begun.value.operation.result
    }
    const benchmarkEffect = plugins
      .list()
      .plugins.find(
        (plugin) => plugin.source.kind === "builtin" && plugin.source.id === "dev.yadaw.gain"
      )
    if (!benchmarkEffect) throw new Error("Built-in YADAW Gain VST3 is unavailable")
    const result = rpcSuccess(
      meta,
      await createAudioBenchmarkReport(audioHostService, benchmarkEffect)
    )
    operations.registry.finish(meta.mutation!.operationId, "committed", result)
    return result
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

import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { createAudioBenchmarkReport } from "../audio-benchmark-service"
import { assertTrustedSender } from "./support"
export function registerDiagnosticHandlers(context: IpcHandlerContext): void {
  const {
    lifecycle,
    projects,
    plugins,
    audioHost: audioHostService,
    sampleSystemPerformance
  } = context
  ipcMain.handle(IPC_CHANNELS.lifecycleSnapshot, (event) => {
    assertTrustedSender(event)
    return lifecycle.snapshot()
  })

  ipcMain.handle(IPC_CHANNELS.systemPerformanceSnapshot, (event) => {
    assertTrustedSender(event)
    return sampleSystemPerformance()
  })

  ipcMain.handle(IPC_CHANNELS.audioBenchmarkRun, (event) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    const benchmarkEffect = plugins
      .list()
      .plugins.find(
        (plugin) => plugin.source.kind === "builtin" && plugin.source.id === "dev.yadaw.gain"
      )
    if (!benchmarkEffect) throw new Error("Built-in YADAW Gain VST3 is unavailable")
    return createAudioBenchmarkReport(audioHostService, benchmarkEffect)
  })

  ipcMain.handle(IPC_CHANNELS.compiledAudioGraphSnapshot, (event) => {
    assertTrustedSender(event)
    if (!projects.current) return null
    if (!audioHostService) throw new Error("Audio host is not running")
    return audioHostService.compiledAudioGraphSnapshot()
  })
}

import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import {
  assertTrustedSender,
  normalizeAudioDeviceList,
  normalizeAudioRuntime,
  validateAudioBackend,
  validateAudioPreferences,
  validateRoundTripLatencyMeasurementRequest
} from "./support"
export function registerAudioHandlers(context: IpcHandlerContext): void {
  const { audioHost: audioHostService, projects, mixer, lifecycle, isShuttingDown } = context
  ipcMain.handle(IPC_CHANNELS.audioBackends, async (event) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    return audioHostService.listAudioBackends()
  })

  ipcMain.handle(IPC_CHANNELS.audioDevices, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    return normalizeAudioDeviceList(
      await audioHostService.listAudioDevices(validateAudioBackend(value))
    )
  })

  ipcMain.handle(IPC_CHANNELS.audioStart, async (event, value: unknown) => {
    assertTrustedSender(event)
    const transition =
      lifecycle.snapshot().audio.status === "running" ? "reconfiguring" : "starting"
    lifecycle.beginAudio(transition)
    try {
      if (!audioHostService) throw new Error("Audio host is not running")
      const snapshot = normalizeAudioRuntime(
        await audioHostService.startAudioEngine(validateAudioPreferences(value))
      )
      if (projects.current) await mixer.load()
      lifecycle.completeAudio(snapshot)
      return snapshot
    } catch (error) {
      const snapshot = audioHostService
        ? await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
        : lifecycle.snapshot().audio.runtime
      lifecycle.failAudio(error, normalizeAudioRuntime(snapshot))
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.audioStop, async (event) => {
    assertTrustedSender(event)
    lifecycle.beginAudio("stopping")
    try {
      if (!audioHostService) throw new Error("Audio host is not running")
      const snapshot = normalizeAudioRuntime(await audioHostService.stopAudioEngine())
      lifecycle.completeAudio(snapshot)
      return snapshot
    } catch (error) {
      const snapshot = audioHostService
        ? await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
        : lifecycle.snapshot().audio.runtime
      lifecycle.failAudio(error, normalizeAudioRuntime(snapshot))
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.audioSnapshot, async (event) => {
    assertTrustedSender(event)
    if (isShuttingDown()) return lifecycle.snapshot().audio.runtime
    if (!audioHostService) throw new Error("Audio host is not running")
    const snapshot = normalizeAudioRuntime(await audioHostService.audioEngineSnapshot())
    lifecycle.refreshAudio(snapshot)
    return snapshot
  })

  ipcMain.handle(IPC_CHANNELS.audioRoundTripLatencyStart, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    return audioHostService.startRoundTripLatencyMeasurement(
      validateRoundTripLatencyMeasurementRequest(value)
    )
  })

  ipcMain.handle(IPC_CHANNELS.audioRoundTripLatencySnapshot, async (event) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    return audioHostService.roundTripLatencyMeasurementSnapshot()
  })
}

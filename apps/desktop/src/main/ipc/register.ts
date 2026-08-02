import { BrowserWindow } from "electron"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import type { ApplicationServices, IpcHandlerContext } from "./context"
import { registerAudioHandlers } from "./audio-handlers"
import { registerDiagnosticHandlers } from "./diagnostic-handlers"
import { registerMidiHandlers } from "./midi-handlers"
import { registerMixerHandlers } from "./mixer-handlers"
import { registerPluginHandlers } from "./plugin-handlers"
import { registerProjectHandlers } from "./project-handlers"
import { registerRecordingHandlers } from "./recording-handlers"
import { registerSettingsRpcHandlers } from "./settings-rpc-handlers"
import { registerSystemHandlers } from "./system-handlers"
import { registerTransportHandlers } from "./transport-handlers"
import { sampleSystemPerformance } from "./support"
import { ProjectLifecycleService } from "../project-lifecycle-service"
import { synchronizePluginStatesAtomically } from "../plugin-state-synchronizer"

export function registerIpcHandlers(services: ApplicationServices): void {
  const { plugins, audioHost, projectGraph, settings } = services
  let pluginSequence = 0
  let midiSequence = 0

  plugins.subscribe((scanEvent) => {
    pluginSequence += 1
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.pluginsScanEvent, {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sourceEpoch: services.lifecycle.applicationState.resources.epoch,
        sequence: pluginSequence,
        resourceRevision: pluginSequence,
        payload: scanEvent
      })
    }
  })
  let midiSnapshotPending = false
  const publishMidiSnapshot = async (): Promise<void> => {
    if (midiSnapshotPending) return
    midiSnapshotPending = true
    try {
      const nativeSnapshot = await audioHost.midiInputSnapshot()
      const snapshot = services.lifecycle.applicationState.midiRuntimeSnapshot(nativeSnapshot)
      for (const window of BrowserWindow.getAllWindows()) {
        midiSequence += 1
        window.webContents.send(IPC_CHANNELS.midiInputEvent, {
          protocolVersion: IPC_PROTOCOL_VERSION,
          sourceEpoch: services.lifecycle.applicationState.audioHost.epoch,
          sequence: midiSequence,
          resourceRevision: snapshot.revision,
          payload: snapshot
        })
      }
    } catch {
      // Helper recovery owns error reporting; the next interval retries.
    } finally {
      midiSnapshotPending = false
    }
  }
  const midiSnapshotTimer = setInterval(() => void publishMidiSnapshot(), 100)
  midiSnapshotTimer.unref()
  const synchronizePluginStates = (): Promise<void> =>
    synchronizePluginStatesAtomically(audioHost, projectGraph)
  const context: IpcHandlerContext = {
    ...services,
    projectLifecycle: new ProjectLifecycleService(
      services.projects,
      services.projectGraph,
      services.lifecycle,
      services.operations,
      services.settings,
      services.waveforms
    ),
    synchronizePluginStates,
    sampleSystemPerformance: () => sampleSystemPerformance(settings, audioHost)
  }
  registerSystemHandlers(context)
  registerAudioHandlers(context)
  registerMixerHandlers(context)
  registerPluginHandlers(context)
  registerMidiHandlers(context)
  registerTransportHandlers(context)
  registerDiagnosticHandlers(context)
  registerSettingsRpcHandlers(context)
  registerProjectHandlers(context)
  registerRecordingHandlers(context)
}

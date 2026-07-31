import { BrowserWindow } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { ApplicationServices, IpcHandlerContext } from "./context"
import { registerAudioHandlers } from "./audio-handlers"
import { registerDiagnosticHandlers } from "./diagnostic-handlers"
import { registerMidiHandlers } from "./midi-handlers"
import { registerMixerHandlers } from "./mixer-handlers"
import { registerPluginHandlers } from "./plugin-handlers"
import { registerProjectHandlers } from "./project-handlers"
import { registerRecordingHandlers } from "./recording-handlers"
import { registerSettingsHandlers } from "./settings-handlers"
import { registerSystemHandlers } from "./system-handlers"
import { registerTransportHandlers } from "./transport-handlers"
import { sampleSystemPerformance } from "./support"
import { ProjectLifecycleService } from "../project-lifecycle-service"

export function registerIpcHandlers(services: ApplicationServices): void {
  const { plugins, audioHost, projectGraph, settings } = services
  plugins.subscribe((scanEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.pluginsScanEvent, scanEvent)
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
        window.webContents.send(IPC_CHANNELS.midiInputEvent, snapshot)
      }
    } catch {
      // Helper recovery owns error reporting; the next interval retries.
    } finally {
      midiSnapshotPending = false
    }
  }
  const midiSnapshotTimer = setInterval(() => void publishMidiSnapshot(), 100)
  midiSnapshotTimer.unref()
  const synchronizePluginStates = async (): Promise<void> => {
    const graph = await projectGraph.snapshot()
    const states = []
    for (const plugin of graph.plugins) {
      try {
        await audioHost.loadPlugin(plugin, graph.sampleRate)
        const state = await audioHost.savePluginState(plugin.id)
        states.push({
          id: plugin.id,
          componentState: state.componentState,
          controllerState: state.controllerState,
          araDocumentState: state.araDocumentState
        })
      } catch (error) {
        console.error(`Could not synchronize VST3 state for ${plugin.id}:`, error)
      }
    }
    if (states.length > 0) await projectGraph.savePluginStates(states)
  }
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
  registerSystemHandlers()
  registerAudioHandlers(context)
  registerMixerHandlers(context)
  registerPluginHandlers(context)
  registerMidiHandlers(context)
  registerTransportHandlers(context)
  registerDiagnosticHandlers(context)
  registerSettingsHandlers(context)
  registerProjectHandlers(context)
  registerRecordingHandlers(context)
}

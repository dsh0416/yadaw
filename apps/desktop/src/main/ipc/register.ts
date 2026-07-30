import { BrowserWindow } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { ApplicationSettingsStore } from "../application-settings"
import type { AudioHostService } from "../audio-host-service"
import type { LifecycleCoordinator } from "../lifecycle-coordinator"
import type { MidiImportService } from "../midi-import-service"
import type { MixerService } from "../mixer-service"
import type { OperationService } from "../operation-service"
import type { PluginCatalogService } from "../plugin-catalog-service"
import type { ProjectService } from "../project-service"
import type { RecordingService } from "../recording-service"
import type { WaveformService } from "../waveform-service"
import type { IpcHandlerContext } from "./context"
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

export function registerIpcHandlers(
  settings: ApplicationSettingsStore,
  projects: ProjectService,
  recordings: RecordingService,
  operations: OperationService,
  waveforms: WaveformService,
  mixer: MixerService,
  plugins: PluginCatalogService,
  midiImport: MidiImportService,
  lifecycle: LifecycleCoordinator,
  audioHost: AudioHostService,
  isShuttingDown: () => boolean
): void {
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
      const snapshot = await audioHost.midiInputSnapshot()
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send(IPC_CHANNELS.midiInputEvent, snapshot)
      }
    } catch {
      // Helper recovery owns error reporting; the next interval retries.
    } finally {
      midiSnapshotPending = false
    }
  }
  const midiSnapshotTimer = setInterval(() => void publishMidiSnapshot(), 250)
  midiSnapshotTimer.unref()
  const synchronizePluginStates = async (): Promise<void> => {
    const graph = await mixer.snapshot()
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
    if (states.length > 0) await mixer.savePluginStates(states)
  }
  const context: IpcHandlerContext = {
    settings,
    projects,
    recordings,
    operations,
    waveforms,
    mixer,
    plugins,
    midiImport,
    lifecycle,
    audioHost,
    isShuttingDown,
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

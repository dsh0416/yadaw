import type { SystemPerformanceSnapshot } from "@yadaw/contracts"
import type { ApplicationSettingsStore } from "../application-settings"
import type { AudioHostService } from "../audio-host-service"
import type { LifecycleCoordinator } from "../lifecycle-coordinator"
import type { MidiImportService } from "../midi-import-service"
import type { MixerRuntimeService } from "../mixer-runtime-service"
import type { OperationService } from "../operation-service"
import type { PluginCatalogService } from "../plugin-catalog-service"
import type { ProjectCommandService } from "../project-command-service"
import type { ProjectGraphService } from "../project-graph-service"
import type { ProjectService } from "../project-service"
import type { RecordingService } from "../recording-service"
import type { TransportService } from "../transport-service"
import type { WaveformService } from "../waveform-service"

export interface ApplicationServices {
  settings: ApplicationSettingsStore
  projects: ProjectService
  recordings: RecordingService
  operations: OperationService
  waveforms: WaveformService
  projectGraph: ProjectGraphService
  projectCommands: ProjectCommandService
  mixerRuntime: MixerRuntimeService
  transport: TransportService
  plugins: PluginCatalogService
  midiImport: MidiImportService
  lifecycle: LifecycleCoordinator
  audioHost: AudioHostService
  isShuttingDown: () => boolean
}

export interface IpcHandlerContext extends ApplicationServices {
  synchronizePluginStates: () => Promise<void>
  sampleSystemPerformance: () => Promise<SystemPerformanceSnapshot>
}

import type { SystemPerformanceSnapshot } from "@yadaw/contracts"
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

export interface IpcHandlerContext {
  settings: ApplicationSettingsStore
  projects: ProjectService
  recordings: RecordingService
  operations: OperationService
  waveforms: WaveformService
  mixer: MixerService
  plugins: PluginCatalogService
  midiImport: MidiImportService
  lifecycle: LifecycleCoordinator
  audioHost: AudioHostService
  isShuttingDown: () => boolean
  synchronizePluginStates: () => Promise<void>
  sampleSystemPerformance: () => Promise<SystemPerformanceSnapshot>
}

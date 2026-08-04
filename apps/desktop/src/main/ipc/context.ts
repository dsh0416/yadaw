import type { SystemPerformanceSnapshot } from "@heron/contracts"
import type { ApplicationSettingsStore } from "../settings"
import type { AudioHostService } from "../audio-host"
import type { LifecycleCoordinator } from "../kernel"
import type { MidiImportService } from "../project"
import type { MixerRuntimeService } from "../audio"
import type { OperationService } from "../kernel"
import type { PluginCatalogService } from "../plugins"
import type { ProjectCommandService } from "../project"
import type { ProjectGraphService } from "../project"
import type { ProjectLifecycleService } from "../project"
import type { ProjectService } from "../project"
import type { RecordingService } from "../recording"
import type { TransportService } from "../audio"
import type { WaveformService } from "../project"

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
  projectLifecycle: ProjectLifecycleService
  synchronizePluginStates: () => Promise<void>
  sampleSystemPerformance: () => Promise<SystemPerformanceSnapshot>
}

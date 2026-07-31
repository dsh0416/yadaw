import type { ApplicationBootstrapSnapshot, ProjectCloseResult } from "./bootstrap"
import type {
  ApplicationCommandId,
  ApplicationWindowCommandId,
  DesktopPlatform,
  NativeEngineInfo,
  ProcessGainRequest,
  ProcessGainResult
} from "./application"
import type {
  AudioBackend,
  AudioBackendDescriptor,
  AudioDeviceList,
  AudioPreferences,
  AudioRuntimeSnapshot,
  DesktopLifecycleEvent,
  DesktopLifecycleSnapshot,
  RoundTripLatencyMeasurement,
  RoundTripLatencyMeasurementRequest
} from "./audio"
import type { AudioBenchmarkReport, SystemPerformanceSnapshot } from "./performance"
import type {
  CompiledAudioGraphSnapshot,
  ProjectGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  ProjectCommand,
  ProjectCommandResult,
  TransportCommand,
  TransportSnapshot
} from "./mixer"
import type {
  MidiImportPlan,
  MidiImportPreview,
  MidiInputSnapshot,
  MidiSyncPreferences
} from "./midi"
import type { OperationEvent } from "./operations"
import type {
  PluginCatalogSnapshot,
  PluginParameterChange,
  PluginParameterInfo,
  PluginRuntimeStatus,
  PluginScanEvent,
  PluginScanRequest
} from "./plugins"
import type {
  CreateProjectRequest,
  ProjectAssetSummary,
  ProjectCloseDisposition,
  ProjectConfiguration,
  ProjectOpenPreparation,
  ProjectSession,
  ProjectWorkspaceSnapshot,
  StartupProgressSnapshot,
  WaveformPeakWindow,
  WaveformWindowRequest
} from "./project"
import type { PendingRecording, RecordingSession } from "./recording"
import type {
  ApplicationSettings,
  ApplicationSettingsPatch,
  AudioHostRuntimePreferences
} from "./settings"
import type { ShortcutPreferences } from "./shortcuts"
import type { RpcRequestMeta, RpcResult } from "./rpc"

export const IPC_CHANNELS = {
  bootstrap: "application:bootstrap",
  engineInfo: "engine:info",
  processGain: "engine:process-gain",
  audioBackends: "audio:list-backends",
  audioDevices: "audio:list-devices",
  audioStart: "audio:start",
  audioStop: "audio:stop",
  audioSnapshot: "audio:snapshot",
  audioRoundTripLatencyStart: "audio:round-trip-latency-start",
  audioRoundTripLatencySnapshot: "audio:round-trip-latency-snapshot",
  projectGraphLoad: "project:graph-load",
  projectGraphReload: "project:graph-reload",
  projectCommandExecute: "project:command-execute",
  mixerPreview: "mixer:preview",
  mixerSnapshot: "mixer:snapshot",
  mixerClearMeterClips: "mixer:clear-meter-clips",
  transportCommand: "transport:command",
  transportSnapshot: "transport:snapshot",
  lifecycleSnapshot: "lifecycle:snapshot",
  lifecycleEvent: "lifecycle:event",
  startupProgressSnapshot: "startup:progress-snapshot",
  startupProgressEvent: "startup:progress-event",
  systemPerformanceSnapshot: "system:performance-snapshot",
  audioBenchmarkRun: "audio-benchmark:run",
  compiledAudioGraphSnapshot: "compiled-audio-graph:snapshot",
  applicationCommandRequested: "application-command:requested",
  applicationWindowCommand: "application-window:command",
  applicationWindowTheme: "application-window:theme",
  projectCreate: "project:create",
  projectPrepareOpen: "project:prepare-open",
  projectOpen: "project:open",
  projectSave: "project:save",
  projectClose: "project:close",
  projectAssetsList: "project:assets-list",
  projectConfigurationUpdate: "project:configuration-update",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsSetSoftwareMonitoring: "settings:set-software-monitoring",
  settingsConfigureAudioHostRuntime: "settings:configure-audio-host-runtime",
  settingsConfigureShortcuts: "settings:configure-shortcuts",
  settingsChooseSwap: "settings:choose-swap",
  settingsOpenSwap: "settings:open-swap",
  recordingStart: "recording:start",
  recordingStop: "recording:stop",
  recordingPendingList: "recording:pending-list",
  recordingRecover: "recording:recover",
  recordingDeletePending: "recording:delete-pending",
  assetAudioRead: "asset:audio-read",
  assetWaveformRead: "asset:waveform-read",
  recordingWaveformSnapshot: "recording:waveform-snapshot",
  pluginsList: "plugins:list",
  pluginsScan: "plugins:scan",
  pluginsScanEvent: "plugins:scan-event",
  pluginEditorOpen: "plugin-editor:open",
  pluginEditorClose: "plugin-editor:close",
  pluginParametersGet: "plugin-parameters:get",
  pluginParameterSet: "plugin-parameter:set",
  midiImportPrepare: "midi-import:prepare",
  midiImportCommit: "midi-import:commit",
  midiInputSnapshot: "midi-input:snapshot",
  midiInputEvent: "midi-input:event",
  midiInputConfigure: "midi-input:configure",
  midiControlLearning: "midi-control:learning",
  operationCancel: "operation:cancel",
  operationEvent: "operation:event"
} as const

export interface YadawDesktopApi {
  readonly platform: DesktopPlatform
  bootstrap(meta: RpcRequestMeta): Promise<RpcResult<ApplicationBootstrapSnapshot>>
  engineInfo(): Promise<NativeEngineInfo>
  processGain(request: ProcessGainRequest): Promise<ProcessGainResult>
  listAudioBackends(): Promise<AudioBackendDescriptor[]>
  listAudioDevices(backend: AudioBackend): Promise<AudioDeviceList>
  startAudioEngine(preferences: AudioPreferences): Promise<AudioRuntimeSnapshot>
  stopAudioEngine(): Promise<AudioRuntimeSnapshot>
  audioEngineSnapshot(): Promise<AudioRuntimeSnapshot>
  startRoundTripLatencyMeasurement(
    request: RoundTripLatencyMeasurementRequest
  ): Promise<RoundTripLatencyMeasurement>
  roundTripLatencyMeasurementSnapshot(): Promise<RoundTripLatencyMeasurement>
  loadProjectGraph(meta: RpcRequestMeta): Promise<RpcResult<ProjectGraphSnapshot>>
  reloadProjectGraph(meta: RpcRequestMeta): Promise<RpcResult<ProjectGraphSnapshot>>
  executeProjectCommand(
    meta: RpcRequestMeta,
    command: ProjectCommand
  ): Promise<RpcResult<ProjectCommandResult>>
  previewMixerParameter(preview: MixerParameterPreview): Promise<void>
  mixerSnapshot(): Promise<MixerRuntimeSnapshot>
  clearMixerMeterClips(): Promise<MixerRuntimeSnapshot>
  transportCommand(command: TransportCommand): Promise<TransportSnapshot>
  transportSnapshot(): Promise<TransportSnapshot>
  lifecycleSnapshot(): Promise<DesktopLifecycleSnapshot>
  subscribeLifecycle(listener: (event: DesktopLifecycleEvent) => void): () => void
  startupProgressSnapshot(): Promise<StartupProgressSnapshot>
  subscribeStartupProgress(listener: (progress: StartupProgressSnapshot) => void): () => void
  systemPerformanceSnapshot(): Promise<SystemPerformanceSnapshot>
  runAudioBenchmark(): Promise<AudioBenchmarkReport>
  compiledAudioGraphSnapshot(): Promise<CompiledAudioGraphSnapshot | null>
  subscribeApplicationCommands(listener: (command: ApplicationCommandId) => void): () => void
  executeApplicationWindowCommand(command: ApplicationWindowCommandId): Promise<void>
  setApplicationWindowTheme(theme: "light" | "dark"): Promise<void>
  createProject(
    meta: RpcRequestMeta,
    request: CreateProjectRequest
  ): Promise<RpcResult<ProjectWorkspaceSnapshot>>
  prepareOpenProject(
    meta: RpcRequestMeta,
    path?: string
  ): Promise<RpcResult<ProjectOpenPreparation | null>>
  openProject(
    meta: RpcRequestMeta,
    path: string,
    recover?: boolean
  ): Promise<RpcResult<ProjectWorkspaceSnapshot>>
  saveProject(meta: RpcRequestMeta, path?: string): Promise<RpcResult<ProjectWorkspaceSnapshot>>
  closeProject(
    meta: RpcRequestMeta,
    disposition?: ProjectCloseDisposition
  ): Promise<RpcResult<ProjectCloseResult>>
  listProjectAssets(): Promise<ProjectAssetSummary[]>
  updateProjectConfiguration(configuration: ProjectConfiguration): Promise<ProjectSession>
  getApplicationSettings(): Promise<ApplicationSettings>
  updateApplicationSettings(patch: ApplicationSettingsPatch): Promise<ApplicationSettings>
  setSoftwareMonitoringEnabled(enabled: boolean): Promise<ApplicationSettings>
  configureAudioHostRuntime(preferences: AudioHostRuntimePreferences): Promise<ApplicationSettings>
  configureShortcuts(preferences: ShortcutPreferences): Promise<ApplicationSettings>
  chooseSwapDirectory(): Promise<ApplicationSettings>
  openSwapDirectory(): Promise<void>
  startRecording(): Promise<RecordingSession>
  stopRecording(): Promise<PendingRecording>
  listPendingRecordings(): Promise<PendingRecording[]>
  recoverRecording(id: string): Promise<void>
  deletePendingRecording(id: string): Promise<void>
  readAssetAudio(id: string): Promise<Uint8Array>
  readAssetWaveform(request: WaveformWindowRequest): Promise<WaveformPeakWindow>
  recordingWaveformSnapshot(request: WaveformWindowRequest): Promise<WaveformPeakWindow>
  listPlugins(): Promise<PluginCatalogSnapshot>
  scanPlugins(request?: PluginScanRequest): Promise<PluginCatalogSnapshot>
  subscribePluginScan(listener: (event: PluginScanEvent) => void): () => void
  openPluginEditor(instanceId: string): Promise<PluginRuntimeStatus>
  closePluginEditor(instanceId: string): Promise<void>
  getPluginParameters(instanceId: string): Promise<PluginParameterInfo[]>
  setPluginParameter(request: PluginParameterChange): Promise<void>
  prepareMidiImport(path?: string): Promise<MidiImportPreview | null>
  commitMidiImport(plan: MidiImportPlan): Promise<ProjectCommandResult>
  midiInputSnapshot(): Promise<MidiInputSnapshot>
  subscribeMidiInput(listener: (snapshot: MidiInputSnapshot) => void): () => void
  configureMidiInput(preferences: MidiSyncPreferences): Promise<MidiInputSnapshot>
  setMidiControlLearning(enabled: boolean): Promise<void>
  subscribeOperations(listener: (event: OperationEvent) => void): () => void
  cancelOperation(id: string): Promise<void>
}

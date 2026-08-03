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
  AudioEngineSessionSnapshot,
  AudioEngineStopSnapshot,
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
  LowLatencyModeConfiguration,
  LowLatencyModeSnapshot,
  ProjectGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  ProjectCommand,
  ProjectCommandResult,
  TransportCommand,
  TransportSnapshot
} from "./mixer"
import type {
  MidiImportCommitResult,
  MidiImportPlan,
  MidiImportPreview,
  MidiRuntimeResourceSnapshot,
  MidiSyncPreferences
} from "./midi"
import type { OperationEvent, OperationStatusSnapshot } from "./operations"
import type {
  PluginCatalogSnapshot,
  AraCallbackNotification,
  PluginEditorOpenResult,
  PluginParameterCommand,
  PluginParameterEnqueueResult,
  PluginParameterInfo,
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
import type {
  PendingRecording,
  RecordingResourceSnapshot,
  RecordingRecoveryResult,
  RecordingStartRequest,
  RecordingStopResult
} from "./recording"
import type {
  ApplicationSettingsResourceSnapshot,
  ApplicationSettingsPatch,
  AudioHostRuntimePreferences
} from "./settings"
import type { ShortcutPreferences } from "./shortcuts"
import type { RpcEvent, RpcRequestMeta, RpcResult, RpcWarning } from "./rpc"

export interface ExternalProjectCommandNotification {
  result: ProjectCommandResult
  warnings: RpcWarning[]
}

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
  projectCommandExternalEvent: "project:command-external-event",
  mixerPreview: "mixer:preview",
  mixerSnapshot: "mixer:snapshot",
  mixerClearMeterClips: "mixer:clear-meter-clips",
  transportCommand: "transport:command",
  transportSnapshot: "transport:snapshot",
  lifecycleSnapshot: "lifecycle:snapshot",
  lifecycleEvent: "lifecycle:event",
  startupProgressEvent: "startup:progress-event",
  systemPerformanceSnapshot: "system:performance-snapshot",
  audioBenchmarkRun: "audio-benchmark:run",
  compiledAudioGraphSnapshot: "compiled-audio-graph:snapshot",
  lowLatencyModeSnapshot: "low-latency-mode:snapshot",
  lowLatencyModeConfigure: "low-latency-mode:configure",
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
  pluginEditorClosedEvent: "plugin-editor:closed-event",
  araCallbackEvent: "ara:callback-event",
  pluginParametersGet: "plugin-parameters:get",
  pluginParameterSet: "plugin-parameter:set",
  midiImportPrepare: "midi-import:prepare",
  midiImportCommit: "midi-import:commit",
  midiInputSnapshot: "midi-input:snapshot",
  midiInputEvent: "midi-input:event",
  midiInputConfigure: "midi-input:configure",
  midiControlLearning: "midi-control:learning",
  operationCancel: "operation:cancel",
  operationEvent: "operation:event",
  operationStatus: "operation:status",
  operationAcknowledge: "operation:acknowledge"
} as const

export interface HeronDesktopApi {
  readonly platform: DesktopPlatform
  bootstrap(meta: RpcRequestMeta): Promise<RpcResult<ApplicationBootstrapSnapshot>>
  engineInfo(meta: RpcRequestMeta): Promise<RpcResult<NativeEngineInfo>>
  processGain(
    meta: RpcRequestMeta,
    request: ProcessGainRequest
  ): Promise<RpcResult<ProcessGainResult>>
  listAudioBackends(meta: RpcRequestMeta): Promise<RpcResult<AudioBackendDescriptor[]>>
  listAudioDevices(meta: RpcRequestMeta, backend: AudioBackend): Promise<RpcResult<AudioDeviceList>>
  startAudioEngine(
    meta: RpcRequestMeta,
    preferences: AudioPreferences
  ): Promise<RpcResult<AudioEngineSessionSnapshot>>
  stopAudioEngine(meta: RpcRequestMeta): Promise<RpcResult<AudioEngineStopSnapshot>>
  audioEngineSnapshot(meta: RpcRequestMeta): Promise<RpcResult<AudioRuntimeSnapshot>>
  startRoundTripLatencyMeasurement(
    meta: RpcRequestMeta,
    request: RoundTripLatencyMeasurementRequest
  ): Promise<RpcResult<RoundTripLatencyMeasurement>>
  roundTripLatencyMeasurementSnapshot(
    meta: RpcRequestMeta
  ): Promise<RpcResult<RoundTripLatencyMeasurement>>
  loadProjectGraph(meta: RpcRequestMeta): Promise<RpcResult<ProjectGraphSnapshot>>
  reloadProjectGraph(meta: RpcRequestMeta): Promise<RpcResult<ProjectGraphSnapshot>>
  executeProjectCommand(
    meta: RpcRequestMeta,
    command: ProjectCommand
  ): Promise<RpcResult<ProjectCommandResult>>
  subscribeExternalProjectCommands(
    listener: (event: RpcEvent<ExternalProjectCommandNotification>) => void
  ): () => void
  previewMixerParameter(
    meta: RpcRequestMeta,
    preview: MixerParameterPreview
  ): Promise<RpcResult<void>>
  mixerSnapshot(meta: RpcRequestMeta): Promise<RpcResult<MixerRuntimeSnapshot>>
  clearMixerMeterClips(meta: RpcRequestMeta): Promise<RpcResult<MixerRuntimeSnapshot>>
  transportCommand(
    meta: RpcRequestMeta,
    command: TransportCommand
  ): Promise<RpcResult<TransportSnapshot>>
  transportSnapshot(meta: RpcRequestMeta): Promise<RpcResult<TransportSnapshot>>
  lifecycleSnapshot(meta: RpcRequestMeta): Promise<RpcResult<DesktopLifecycleSnapshot>>
  subscribeLifecycle(listener: (event: RpcEvent<DesktopLifecycleEvent>) => void): () => void
  subscribeStartupProgress(listener: (event: RpcEvent<StartupProgressSnapshot>) => void): () => void
  systemPerformanceSnapshot(meta: RpcRequestMeta): Promise<RpcResult<SystemPerformanceSnapshot>>
  runAudioBenchmark(meta: RpcRequestMeta): Promise<RpcResult<AudioBenchmarkReport>>
  compiledAudioGraphSnapshot(
    meta: RpcRequestMeta
  ): Promise<RpcResult<CompiledAudioGraphSnapshot | null>>
  lowLatencyModeSnapshot(meta: RpcRequestMeta): Promise<RpcResult<LowLatencyModeSnapshot>>
  configureLowLatencyMode(
    meta: RpcRequestMeta,
    configuration: LowLatencyModeConfiguration
  ): Promise<RpcResult<LowLatencyModeSnapshot>>
  subscribeApplicationCommands(
    listener: (event: RpcEvent<ApplicationCommandId>) => void
  ): () => void
  executeApplicationWindowCommand(
    meta: RpcRequestMeta,
    command: ApplicationWindowCommandId
  ): Promise<RpcResult<void>>
  setApplicationWindowTheme(meta: RpcRequestMeta, theme: "light" | "dark"): Promise<RpcResult<void>>
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
  listProjectAssets(meta: RpcRequestMeta): Promise<RpcResult<ProjectAssetSummary[]>>
  updateProjectConfiguration(
    meta: RpcRequestMeta,
    configuration: ProjectConfiguration
  ): Promise<RpcResult<ProjectSession>>
  getApplicationSettings(
    meta: RpcRequestMeta
  ): Promise<RpcResult<ApplicationSettingsResourceSnapshot>>
  updateApplicationSettings(
    meta: RpcRequestMeta,
    patch: ApplicationSettingsPatch
  ): Promise<RpcResult<ApplicationSettingsResourceSnapshot>>
  setSoftwareMonitoringEnabled(
    meta: RpcRequestMeta,
    enabled: boolean
  ): Promise<RpcResult<ApplicationSettingsResourceSnapshot>>
  configureAudioHostRuntime(
    meta: RpcRequestMeta,
    preferences: AudioHostRuntimePreferences
  ): Promise<RpcResult<ApplicationSettingsResourceSnapshot>>
  configureShortcuts(
    meta: RpcRequestMeta,
    preferences: ShortcutPreferences
  ): Promise<RpcResult<ApplicationSettingsResourceSnapshot>>
  chooseSwapDirectory(meta: RpcRequestMeta): Promise<RpcResult<ApplicationSettingsResourceSnapshot>>
  openSwapDirectory(meta: RpcRequestMeta): Promise<RpcResult<void>>
  startRecording(
    meta: RpcRequestMeta,
    request: RecordingStartRequest
  ): Promise<RpcResult<RecordingResourceSnapshot>>
  stopRecording(meta: RpcRequestMeta): Promise<RpcResult<RecordingStopResult>>
  listPendingRecordings(meta: RpcRequestMeta): Promise<RpcResult<PendingRecording[]>>
  recoverRecording(meta: RpcRequestMeta, id: string): Promise<RpcResult<RecordingRecoveryResult>>
  deletePendingRecording(meta: RpcRequestMeta, id: string): Promise<RpcResult<void>>
  readAssetAudio(meta: RpcRequestMeta, id: string): Promise<RpcResult<Uint8Array>>
  readAssetWaveform(
    meta: RpcRequestMeta,
    request: WaveformWindowRequest
  ): Promise<RpcResult<WaveformPeakWindow>>
  recordingWaveformSnapshot(
    meta: RpcRequestMeta,
    request: WaveformWindowRequest
  ): Promise<RpcResult<WaveformPeakWindow>>
  listPlugins(meta: RpcRequestMeta): Promise<RpcResult<PluginCatalogSnapshot>>
  scanPlugins(
    meta: RpcRequestMeta,
    request?: PluginScanRequest
  ): Promise<RpcResult<PluginCatalogSnapshot>>
  subscribePluginScan(listener: (event: RpcEvent<PluginScanEvent>) => void): () => void
  openPluginEditor(
    meta: RpcRequestMeta,
    instanceId: string
  ): Promise<RpcResult<PluginEditorOpenResult>>
  closePluginEditor(meta: RpcRequestMeta): Promise<RpcResult<void>>
  subscribePluginEditorClosed(
    listener: (event: RpcEvent<{ instanceId: string }>) => void
  ): () => void
  subscribeAraCallbacks(listener: (event: RpcEvent<AraCallbackNotification>) => void): () => void
  getPluginParameters(meta: RpcRequestMeta): Promise<RpcResult<PluginParameterInfo[]>>
  setPluginParameter(
    meta: RpcRequestMeta,
    request: PluginParameterCommand
  ): Promise<RpcResult<PluginParameterEnqueueResult>>
  prepareMidiImport(
    meta: RpcRequestMeta,
    path?: string
  ): Promise<RpcResult<MidiImportPreview | null>>
  commitMidiImport(
    meta: RpcRequestMeta,
    plan: MidiImportPlan
  ): Promise<RpcResult<MidiImportCommitResult>>
  midiInputSnapshot(meta: RpcRequestMeta): Promise<RpcResult<MidiRuntimeResourceSnapshot>>
  subscribeMidiInput(listener: (event: RpcEvent<MidiRuntimeResourceSnapshot>) => void): () => void
  configureMidiInput(
    meta: RpcRequestMeta,
    preferences: MidiSyncPreferences
  ): Promise<RpcResult<MidiRuntimeResourceSnapshot>>
  setMidiControlLearning(
    meta: RpcRequestMeta,
    enabled: boolean
  ): Promise<RpcResult<MidiRuntimeResourceSnapshot>>
  subscribeOperations(listener: (event: RpcEvent<OperationEvent>) => void): () => void
  operationStatus(
    meta: RpcRequestMeta,
    id: string
  ): Promise<RpcResult<OperationStatusSnapshot | null>>
  cancelOperation(
    meta: RpcRequestMeta,
    id: string
  ): Promise<RpcResult<OperationStatusSnapshot | null>>
  acknowledgeOperation(meta: RpcRequestMeta, id: string): Promise<RpcResult<boolean>>
}

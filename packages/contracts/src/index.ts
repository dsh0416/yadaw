export const IPC_CHANNELS = {
  engineInfo: "engine:info",
  processGain: "engine:process-gain",
  audioBackends: "audio:list-backends",
  audioDevices: "audio:list-devices",
  audioStart: "audio:start",
  audioStop: "audio:stop",
  audioSnapshot: "audio:snapshot",
  mixerLoad: "mixer:load",
  mixerReload: "mixer:reload",
  mixerExecute: "mixer:execute",
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
  audioBenchmarkMenuOpen: "audio-benchmark:menu-open",
  projectCreate: "project:create",
  projectPrepareOpen: "project:prepare-open",
  projectOpen: "project:open",
  projectSave: "project:save",
  projectClose: "project:close",
  projectAssetsList: "project:assets-list",
  projectConfigurationUpdate: "project:configuration-update",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  settingsConfigureAudioHostRuntime: "settings:configure-audio-host-runtime",
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
  operationCancel: "operation:cancel",
  operationEvent: "operation:event"
} as const

export interface NativeEngineInfo {
  backend: string
  version: string
  nodeApi: number
}

export interface ProcessGainRequest {
  samples: number[]
  gain: number
}

export interface ProcessGainResult {
  samples: number[]
  peak: number
}

export interface YadawDesktopApi {
  engineInfo(): Promise<NativeEngineInfo>
  processGain(request: ProcessGainRequest): Promise<ProcessGainResult>
  listAudioBackends(): Promise<AudioBackendDescriptor[]>
  listAudioDevices(backend: AudioBackend): Promise<AudioDeviceList>
  startAudioEngine(preferences: AudioPreferences): Promise<AudioRuntimeSnapshot>
  stopAudioEngine(): Promise<AudioRuntimeSnapshot>
  audioEngineSnapshot(): Promise<AudioRuntimeSnapshot>
  loadMixerGraph(): Promise<MixerGraphSnapshot>
  reloadMixerGraph(): Promise<MixerGraphSnapshot>
  executeProjectCommand(command: ProjectCommand): Promise<ProjectCommandResult>
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
  subscribeAudioBenchmarkRequests(listener: () => void): () => void
  createProject(request: CreateProjectRequest): Promise<ProjectWorkspaceSnapshot>
  prepareOpenProject(path?: string): Promise<ProjectOpenPreparation | null>
  openProject(path: string, recover?: boolean): Promise<ProjectWorkspaceSnapshot>
  saveProject(path?: string): Promise<ProjectSession | null>
  closeProject(disposition?: ProjectCloseDisposition): Promise<boolean>
  listProjectAssets(): Promise<ProjectAssetSummary[]>
  updateProjectConfiguration(configuration: ProjectConfiguration): Promise<ProjectSession>
  getApplicationSettings(): Promise<ApplicationSettings>
  updateApplicationSettings(patch: ApplicationSettingsPatch): Promise<ApplicationSettings>
  configureAudioHostRuntime(preferences: AudioHostRuntimePreferences): Promise<ApplicationSettings>
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
  subscribeOperations(listener: (event: OperationEvent) => void): () => void
  cancelOperation(id: string): Promise<void>
}

export const PROJECT_SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000] as const
export type ProjectSampleRate = (typeof PROJECT_SAMPLE_RATES)[number]
export type RecordingBitDepth = "float32" | "pcm24" | "pcm16"
export type ThemePreference = "light" | "dark" | "system"

export type StartupPhase =
  | "starting"
  | "loading-catalog"
  | "scanning-plugins"
  | "starting-audio"
  | "opening-workspace"
  | "ready"
  | "failed"

export interface StartupProgressSnapshot {
  phase: StartupPhase
  progress: number
  label: string
  detail: string
  completed: number | null
  total: number | null
  warnings: number
}

export interface ProjectConfiguration {
  name: string
  sampleRate: ProjectSampleRate
  timeSignatureNumerator: number
  timeSignatureDenominator: number
  waveformDisplayMode: WaveformDisplayMode
}

export type WaveformDisplayMode = "separate" | "aggregate"

export interface WaveformWindowRequest {
  id: string
  startFrame: number
  endFrame: number
  maxBuckets: number
}

export interface WaveformPeakWindow {
  id: string
  sampleRate: number
  channels: number
  frameCount: number
  startFrame: number
  endFrame: number
  framesPerBucket: number
  bucketCount: number
  peaks: Uint8Array
}

export interface CreateProjectRequest extends ProjectConfiguration {
  path?: string
}

export interface ProjectSession {
  id: string
  path: string
  configuration: ProjectConfiguration
  dirty: boolean
  recoveredWorkingCopy: boolean
}

export interface ProjectOpenPreparation {
  path: string
  recoverableWorkingCopy: boolean
}

export type ProjectLifecycleState =
  | { status: "closed"; error: string | null }
  | { status: "creating"; error: null }
  | { status: "opening"; error: null }
  | { status: "open"; session: ProjectSession; error: string | null }
  | { status: "saving"; session: ProjectSession; error: null }
  | { status: "closing"; session: ProjectSession; error: null }

export type ProjectCloseDisposition = "save" | "discard" | "cancel"

export interface ProjectAssetSummary {
  id: string
  name: string
  sampleRate: number
  channels: number
  bitDepth: RecordingBitDepth
  frameCount: bigint
}

export interface ProjectWorkspaceSnapshot {
  session: ProjectSession
  graph: MixerGraphSnapshot
  assets: ProjectAssetSummary[]
}

export interface RecentProject {
  path: string
  name: string
  openedAt: number
}

export type MeterPeakHold = "800ms" | "2s" | "4s" | "infinite"
export type MeterReturnRate = "iec-type-i"
export type AudioHostThreadSetting = "auto" | number
export type PluginEditorMode = "native" | "parameters"

export interface PluginEditorPreference {
  mode: PluginEditorMode
  zoomPercent: number
}

export interface AudioHostRuntimePreferences {
  workerThreads: AudioHostThreadSetting
  maxBlockingThreads: AudioHostThreadSetting
  egressConcurrency: AudioHostThreadSetting
}

export interface ResolvedAudioHostRuntimePreferences {
  workerThreads: number
  maxBlockingThreads: number
  egressConcurrency: number
}

export interface ApplicationSettings {
  swapDirectory: string
  recordingBitDepth: RecordingBitDepth
  theme: ThemePreference
  meterPeakHold: MeterPeakHold
  meterReturnRate: MeterReturnRate
  audioHostRuntime: AudioHostRuntimePreferences
  pluginEditors: Record<string, PluginEditorPreference>
  recentProjects: RecentProject[]
}

export type ApplicationSettingsPatch = Partial<
  Pick<
    ApplicationSettings,
    "swapDirectory" | "recordingBitDepth" | "theme" | "meterPeakHold" | "meterReturnRate"
  >
>

export type OperationPhase =
  | "closing-recording"
  | "repairing-header"
  | "hashing"
  | "resampling"
  | "quantizing"
  | "writing-large-object"
  | "committing-database"
  | "saving-archive"
  | "loading-project-archive"
  | "loading-project-database"
  | "restoring-project-state"
  | "loading-mixer"
  | "loading-project-assets"
  | "preparing-waveforms"
  | "cleaning-up"

export type OperationState = "running" | "completed" | "failed" | "cancelled"

export interface OperationSnapshot {
  id: string
  title: string
  description?: string | null
  phase: OperationPhase
  state: OperationState
  completedUnits: number | null
  totalUnits: number | null
  cancellable: boolean
  message: string | null
  dropoutFrames: number
}

export interface OperationEvent {
  type: "upsert" | "remove"
  operation: OperationSnapshot
}

export interface RecordingSession {
  id: string
  startedAt: number
  swapPath: string
  startFrame: number
  trackIds: string[]
}

export type RecordingLifecycleState =
  | { status: "idle"; error: string | null }
  | { status: "starting"; error: null }
  | { status: "recording"; session: RecordingSession; error: null }
  | { status: "stopping"; session: RecordingSession; error: null }
  | { status: "finalizing"; session: RecordingSession; error: null }
  | { status: "recovering"; recordingId: string; error: null }

export type PendingRecordingState = "partial" | "ready" | "committed"

export interface RecordedTrackAsset {
  assetId: string
  trackId: string
  name: string
  sampleRate: number
  channels: number
  frameCount: number
}

export interface PendingRecording {
  id: string
  state: PendingRecordingState
  audioPath: string
  sidecarPath: string
  projectPath: string
  sampleRate: number
  channels: number
  startedAt: number
  dropoutFrames: number
  assetExists: boolean
  recordedTracks: RecordedTrackAsset[]
}

export interface CpuCoreSnapshot {
  index: number
  speedMhz: number
  usagePercent: number | null
}

export interface CpuSnapshot {
  overallUsagePercent: number | null
  cores: CpuCoreSnapshot[]
}

export interface MemorySnapshot {
  totalBytes: number
  usedBytes: number
  freeBytes: number
  usagePercent: number
}

export type StorageSpaceState = "available" | "unconfigured" | "unavailable"

export interface StorageSpaceSnapshot {
  id: "workspace" | "swap"
  path: string | null
  state: StorageSpaceState
  totalBytes: number | null
  freeBytes: number | null
}

export interface SystemPerformanceSnapshot {
  capturedAt: number
  cpu: CpuSnapshot
  memory: MemorySnapshot
  storage: StorageSpaceSnapshot[]
  audioIpc: AudioIpcPerformanceSnapshot | null
}

export interface AudioIpcPerformanceSnapshot {
  nativeBuildFingerprint: string
  sessionEpoch: string
  heartbeat: {
    ageMs: number | null
    ipcGeneration: number
    tokioGeneration: number
    winitGeneration: number
    callbackGeneration: number
  }
  requests: {
    normalPending: number
    priorityPending: number
    capacity: number
    timeouts: number
  }
  sharedMemory: {
    outstandingLeases: number
    outstandingBytes: number
    maxLeases: number
    maxBytes: number
    inlinePackets: number
    inlineBytes: number
    sharedPackets: number
    sharedRegions: number
    sharedBytes: number
    arenaRegions: number
    arenaCapacityBytes: number
    arenaUsedBytes: number
    arenaHighWaterBytes: number
    arenaOffers: number
    arenaBusy: number
    arenaQuarantinedRegions: number
    copiedBytes: number
  }
  runtime: {
    requested: AudioHostRuntimePreferences
    resolved: ResolvedAudioHostRuntimePreferences
    egressActive: number
    egressQueueDepth: number
    egressQueueHighWater: number
    egressBatches: number
    blockingJobs: number
  }
  eventQueueDepth: number
  telemetry: {
    epoch: string
    graphRevision: number
    callbackGeneration: number
    meterSlots: number
    capacity: number
    fallbackReads: number
  }
  parameterRing: {
    used: number
    capacity: number
    softFull: number
    hardFull: number
    boundaryFallbacks: number
    staleEpoch: number
  }
}

export type AudioBenchmarkRating = "limited" | "basic" | "good" | "excellent"

export interface AudioBenchmarkScenario {
  id: string
  label: string
  description: string
  sampleRate: number
  blockSize: number
  tracks: number
  buses: number
  sends: number
  elapsedMs: number
  audioDurationMs: number
  averageBlockMs: number
  p95BlockMs: number
  p99BlockMs: number
  maxBlockMs: number
  bufferBudgetMs: number
  p99DeadlineUtilizationPercent: number
  deadlineMisses: number
  measuredBlocks: number
  realtimeFactor: number
}

export type AudioIpcBenchmarkKind =
  | "inline-round-trip"
  | "shared-cold"
  | "shared-warm-sequential"
  | "shared-saturated"
  | "concurrent-routing"
  | "telemetry-read"

export interface AudioIpcBenchmarkScenario {
  id: string
  label: string
  description: string
  kind: AudioIpcBenchmarkKind
  payloadBytes: number
  iterations: number
  concurrency: number
  elapsedMs: number
  operationsPerSecond: number
  throughputMiBPerSecond: number | null
  latencyP50Us: number | null
  latencyP95Us: number | null
  latencyP99Us: number | null
}

export interface AudioIpcBenchmarkReport {
  durationMs: number
  buildProfile: "debug" | "release"
  runtime: ResolvedAudioHostRuntimePreferences
  arenaOffers: number
  messagePackBodyBytes: number
  scenarios: readonly AudioIpcBenchmarkScenario[]
}

export interface AudioBenchmarkSystemInfo {
  cpuModel: string
  logicalCores: number
  platform: string
  architecture: string
}

export interface AudioBenchmarkReport {
  measuredAt: number
  durationMs: number
  overallRealtimeFactor: number
  worstP99DeadlineUtilizationPercent: number
  rating: AudioBenchmarkRating
  system: AudioBenchmarkSystemInfo
  scenarios: readonly AudioBenchmarkScenario[]
  ipc: AudioIpcBenchmarkReport
}

export const AUDIO_BACKENDS = ["wasapi", "asio", "coreaudio", "alsa"] as const
export type AudioBackend = (typeof AUDIO_BACKENDS)[number]

export interface AudioBackendDescriptor {
  id: AudioBackend
  label: string
  available: boolean
}

export interface AudioDeviceDescriptor {
  id: string
  name: string
  isDefault: boolean
  defaultSampleRate: number | null
  minBufferSize: number | null
  maxBufferSize: number | null
  channelCount: number | null
}

export interface AudioDeviceList {
  inputs: AudioDeviceDescriptor[]
  outputs: AudioDeviceDescriptor[]
}

export const AUDIO_BUFFER_SIZES = [32, 64, 128, 256, 512, 1024, 2048] as const
export type AudioBufferSize = number

export interface AudioPreferences {
  backend: AudioBackend
  inputDeviceId: string
  outputDeviceId: string
  bufferSize: AudioBufferSize
}

export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  backend: "wasapi",
  inputDeviceId: "",
  outputDeviceId: "",
  bufferSize: 256
}

export type AudioEngineState = "stopped" | "running" | "error"
export type AudioClockSync = "inactive" | "shared-device" | "adaptive-resampled"

export interface AudioRuntimeSnapshot {
  state: AudioEngineState
  requestedBufferSize: number | null
  sampleRate: number | null
  inputSampleRate: number | null
  inputBufferSize: number | null
  outputBufferSize: number | null
  ringBufferCapacityFrames: number | null
  ringBufferFillFrames: number | null
  inputLatencyMs: number | null
  outputLatencyMs: number | null
  ringBufferLatencyMs: number | null
  engineLatencyMs: number | null
  estimatedRoundTripLatencyMs: number | null
  xruns: number
  clockSync: AudioClockSync
  bufferFallback: boolean
}

export const INITIAL_AUDIO_RUNTIME_SNAPSHOT: Readonly<AudioRuntimeSnapshot> = {
  state: "stopped",
  requestedBufferSize: null,
  sampleRate: null,
  inputSampleRate: null,
  inputBufferSize: null,
  outputBufferSize: null,
  ringBufferCapacityFrames: null,
  ringBufferFillFrames: null,
  inputLatencyMs: null,
  outputLatencyMs: null,
  ringBufferLatencyMs: null,
  engineLatencyMs: null,
  estimatedRoundTripLatencyMs: null,
  xruns: 0,
  clockSync: "inactive",
  bufferFallback: false
}

export type AudioLifecycleState =
  | { status: "stopped"; runtime: AudioRuntimeSnapshot; error: string | null }
  | { status: "starting"; runtime: AudioRuntimeSnapshot; error: null }
  | { status: "running"; runtime: AudioRuntimeSnapshot; error: string | null }
  | { status: "reconfiguring"; runtime: AudioRuntimeSnapshot; error: null }
  | { status: "stopping"; runtime: AudioRuntimeSnapshot; error: null }
  | { status: "error"; runtime: AudioRuntimeSnapshot; error: string }

export interface DesktopLifecycleSnapshot {
  revision: number
  project: ProjectLifecycleState
  audio: AudioLifecycleState
  recording: RecordingLifecycleState
}

export type DesktopLifecycleEvent =
  | {
      type: "project"
      revision: number
      state: ProjectLifecycleState
    }
  | {
      type: "audio"
      revision: number
      state: AudioLifecycleState
    }
  | {
      type: "recording"
      revision: number
      state: RecordingLifecycleState
    }

export const MUSICAL_TICKS_PER_QUARTER = 960
export const DEFAULT_INSTRUMENT_COLOR = "#73D6A2"

export type MixerChannelKind = "audio" | "instrument" | "bus" | "master" | "output"
export type MixerInputFormat = "mono" | "stereo"
export type MixerSendTap = "pre" | "post" | "post-pan"
export type PluginKind = "effect" | "instrument"
export type PluginInstanceRole = "instrument" | "insert"
export type PluginSource = { kind: "builtin"; id: string } | { kind: "external" }
export type PluginCompatibility =
  | "compatible"
  | "unsupported-architecture"
  | "unsupported-buses"
  | "unsupported-sample-format"
  | "quarantined"
  | "load-error"

export interface PluginAudioBusInfo {
  direction: "input" | "output"
  kind: "main" | "aux"
  name: string
  channels: number
  defaultActive: boolean
}

export interface PluginDescriptor {
  source: PluginSource
  classId: string
  modulePath: string
  name: string
  vendor: string
  version: string
  category: string
  kind: PluginKind
  architecture: string
  buses: PluginAudioBusInfo[]
  hasEditor: boolean
  compatibility: PluginCompatibility
  compatibilityReason: string | null
}

export function pluginDescriptorKey(descriptor: PluginDescriptor): string {
  return descriptor.source.kind === "builtin"
    ? `${descriptor.source.id}:${descriptor.classId}`
    : `${descriptor.modulePath}:${descriptor.classId}`
}

export interface PluginCatalogSnapshot {
  scannerVersion: number
  scanning: boolean
  scannedAt: number | null
  plugins: PluginDescriptor[]
}

export interface PluginScanRequest {
  paths?: string[]
  retryQuarantined?: boolean
  force?: boolean
}

export type PluginScanEvent =
  | { type: "started"; total: number }
  | { type: "progress"; completed: number; total: number; path: string }
  | { type: "quarantined"; path: string; reason: string }
  | { type: "completed"; catalog: PluginCatalogSnapshot }

export interface PluginInstanceState {
  id: string
  channelId: string
  role: PluginInstanceRole
  slotOrder: number
  classId: string
  descriptor: PluginDescriptor
  enabled: boolean
  componentState: Uint8Array
  controllerState: Uint8Array
}

export type PluginRuntimeState =
  "unloaded" | "loading" | "active" | "bypassed" | "missing" | "quarantined" | "failed"

export interface PluginRuntimeStatus {
  instanceId: string
  state: PluginRuntimeState
  editorOpen: boolean
  editorMode?: PluginEditorMode
  recoveryState?: "none" | "recovered-bypassed"
  failureStage?: "initialize" | "restore" | "process" | "editor" | "state-save" | null
  latencySamples: number
  tailSamples: number | null
  error: string | null
}

export interface PluginParameterInfo {
  id: number
  title: string
  shortTitle: string
  units: string
  stepCount: number
  defaultNormalized: number
  normalized: number
  flags: number
}

export interface PluginParameterChange {
  instanceId: string
  parameterId: number
  normalized: number
  gesture: "begin" | "perform" | "end"
}

export interface TempoEventState {
  tick: number
  beatsPerMinute: number
}

export interface TimeSignatureEventState {
  tick: number
  numerator: number
  denominator: number
}

export interface TempoMapSnapshot {
  ticksPerQuarter: typeof MUSICAL_TICKS_PER_QUARTER
  tempoEvents: TempoEventState[]
  timeSignatureEvents: TimeSignatureEventState[]
}

export interface MidiNoteState {
  id: string
  startTick: number
  durationTicks: number
  channel: number
  key: number
  velocity: number
  releaseVelocity: number
}

export type MidiEventKind =
  | "control-change"
  | "pitch-bend"
  | "program-change"
  | "channel-pressure"
  | "poly-pressure"
  | "sysex"

export interface MidiEventState {
  id: string
  tick: number
  channel: number | null
  kind: MidiEventKind
  data: Uint8Array
}

export interface MidiClipState {
  id: string
  sourceId: string
  trackId: string
  name: string
  startTick: number
  lengthTicks: number
  sourceOffsetTicks: number
  notes: MidiNoteState[]
  events: MidiEventState[]
}

export interface MidiImportTrackPreview {
  sourceTrack: number
  sequence: number
  name: string
  noteCount: number
  eventCount: number
  lengthTicks: number
  tempoMap: TempoMapSnapshot
  warnings: string[]
}

export interface MidiImportPreview {
  token: string
  path: string
  format: 0 | 1 | 2
  sourceTiming: string
  tracks: MidiImportTrackPreview[]
  tempoMap: TempoMapSnapshot
  warnings: string[]
}

export type MidiImportTrackTarget =
  | { type: "ignore" }
  | { type: "existing"; channelId: string; instrumentClassId?: string }
  | { type: "new"; name?: string; instrumentClassId?: string }

export interface MidiImportPlan {
  token: string
  importTempoMap: boolean
  insertionTick: number
  tracks: Array<{
    sourceTrack: number
    sequence: number
    target: MidiImportTrackTarget
  }>
}

export interface MixerChannelState {
  id: string
  kind: MixerChannelKind
  name: string
  color: string
  sortOrder: number
  inputFormat: MixerInputFormat | null
  gainDb: number
  pan: number
  muted: boolean
  soloed: boolean
  outputChannelId: string | null
  recordArmed: boolean
  inputChannels: number[]
  hardwareOutputChannels: number[]
}

export interface TimelineClipState {
  id: string
  assetId: string
  trackId: string
  name: string
  startFrame: number
  sourceOffsetFrames: number
  lengthFrames: number
  assetSampleRate: number
  assetChannels: number
}

export interface MixerSendState {
  id: string
  sourceChannelId: string
  targetChannelId: string
  sortOrder: number
  enabled: boolean
  tap: MixerSendTap
  levelDb: number
}

export interface MixerGraphSnapshot {
  sampleRate: number
  channels: MixerChannelState[]
  clips: TimelineClipState[]
  sends: MixerSendState[]
  plugins: PluginInstanceState[]
  midiClips: MidiClipState[]
  tempoMap: TempoMapSnapshot
}

export type MixerChannelPatch = Partial<
  Pick<
    MixerChannelState,
    | "name"
    | "color"
    | "sortOrder"
    | "inputFormat"
    | "gainDb"
    | "pan"
    | "muted"
    | "soloed"
    | "outputChannelId"
    | "recordArmed"
    | "inputChannels"
    | "hardwareOutputChannels"
  >
>

export type MixerSendPatch = Partial<
  Pick<MixerSendState, "targetChannelId" | "sortOrder" | "enabled" | "tap" | "levelDb">
>

export type PluginInstancePatch = Partial<
  Pick<PluginInstanceState, "slotOrder" | "enabled" | "componentState" | "controllerState">
>

export type ProjectCommand =
  | { type: "create-channel"; channel: MixerChannelState }
  | { type: "delete-channel"; channelId: string }
  | { type: "update-channel"; channelId: string; patch: MixerChannelPatch }
  | { type: "create-send"; send: MixerSendState }
  | { type: "delete-send"; sendId: string }
  | { type: "update-send"; sendId: string; patch: MixerSendPatch }
  | { type: "create-clip"; clip: TimelineClipState }
  | { type: "delete-clip"; clipId: string }
  | { type: "move-clip"; clipId: string; trackId: string; startFrame: number }
  | { type: "create-plugin"; plugin: PluginInstanceState }
  | { type: "delete-plugin"; pluginId: string }
  | { type: "update-plugin"; pluginId: string; patch: PluginInstancePatch }
  | {
      type: "move-plugin"
      pluginId: string
      channelId: string
      role: PluginInstanceRole
      slotOrder: number
    }
  | { type: "replace-plugin"; pluginId: string; plugin: PluginInstanceState }
  | { type: "create-midi-clip"; clip: MidiClipState }
  | { type: "delete-midi-clip"; clipId: string }
  | { type: "move-midi-clip"; clipId: string; trackId: string; startTick: number }
  | { type: "replace-tempo-map"; tempoMap: TempoMapSnapshot }
  | { type: "batch"; commands: ProjectCommand[] }

export interface ProjectCommandResult {
  graph: MixerGraphSnapshot
  inverse: ProjectCommand
}

export type MixerParameterPreview =
  | {
      target: "channel"
      id: string
      parameter: "gainDb" | "pan"
      value: number
    }
  | {
      target: "send"
      id: string
      parameter: "levelDb"
      value: number
    }

export interface MixerChannelMeter {
  channelId: string
  preFaderPeak: [number, number]
  postFaderPeak: [number, number]
  heldPeak: [number, number]
  clipped: boolean
}

export interface MixerRuntimeSnapshot {
  meters: MixerChannelMeter[]
  capturedAt: number
}

export type TransportState = "stopped" | "playing" | "recording"
export interface TransportSnapshot {
  state: TransportState
  positionFrames: number
  sampleRate: number
}

export type TransportCommand =
  | { type: "play" }
  | { type: "record" }
  | { type: "pause" }
  | { type: "stop" }
  | { type: "seek"; positionFrames: number }

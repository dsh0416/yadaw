export const IPC_CHANNELS = {
  engineInfo: "engine:info",
  processGain: "engine:process-gain",
  audioBackends: "audio:list-backends",
  audioDevices: "audio:list-devices",
  audioStart: "audio:start",
  audioStop: "audio:stop",
  audioSnapshot: "audio:snapshot",
  mixerLoad: "mixer:load",
  mixerExecute: "mixer:execute",
  mixerPreview: "mixer:preview",
  mixerSnapshot: "mixer:snapshot",
  transportCommand: "transport:command",
  transportSnapshot: "transport:snapshot",
  systemPerformanceSnapshot: "system:performance-snapshot",
  projectCreate: "project:create",
  projectOpen: "project:open",
  projectSave: "project:save",
  projectClose: "project:close",
  projectQuery: "project:query",
  projectTransaction: "project:transaction",
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
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
  executeProjectCommand(command: ProjectCommand): Promise<ProjectCommandResult>
  previewMixerParameter(preview: MixerParameterPreview): Promise<void>
  mixerSnapshot(): Promise<MixerRuntimeSnapshot>
  transportCommand(command: TransportCommand): Promise<TransportSnapshot>
  transportSnapshot(): Promise<TransportSnapshot>
  systemPerformanceSnapshot(): Promise<SystemPerformanceSnapshot>
  createProject(request: CreateProjectRequest): Promise<ProjectSession>
  openProject(path?: string): Promise<ProjectSession | null>
  saveProject(path?: string): Promise<ProjectSession | null>
  closeProject(disposition?: ProjectCloseDisposition): Promise<boolean>
  projectQuery(request: ProjectQueryRequest): Promise<ProjectQueryResult>
  projectTransaction(request: ProjectTransactionRequest): Promise<ProjectQueryResult[]>
  getApplicationSettings(): Promise<ApplicationSettings>
  updateApplicationSettings(patch: ApplicationSettingsPatch): Promise<ApplicationSettings>
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
  subscribeOperations(listener: (event: OperationEvent) => void): () => void
  cancelOperation(id: string): Promise<void>
}

export const PROJECT_SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000] as const
export type ProjectSampleRate = (typeof PROJECT_SAMPLE_RATES)[number]
export type RecordingBitDepth = "float32" | "pcm24" | "pcm16"

export interface ProjectConfiguration {
  name: string
  sampleRate: ProjectSampleRate
  tempo: number
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

export type ProjectCloseDisposition = "save" | "discard" | "cancel"

export type SqlParameter = string | number | bigint | boolean | null | Date | Uint8Array
export type ProjectQueryMethod = "all" | "execute"

export interface ProjectQueryRequest {
  sql: string
  params: SqlParameter[]
  method: ProjectQueryMethod
}

export interface ProjectQueryResult {
  rows: unknown[][]
  rowCount: number
}

export interface ProjectTransactionRequest {
  queries: ProjectQueryRequest[]
}

export interface RecentProject {
  path: string
  name: string
  openedAt: number
}

export interface ApplicationSettings {
  swapDirectory: string
  recordingBitDepth: RecordingBitDepth
  recentProjects: RecentProject[]
}

export type ApplicationSettingsPatch = Partial<Pick<ApplicationSettings, "swapDirectory" | "recordingBitDepth">>

export type OperationPhase =
  | "closing-recording"
  | "repairing-header"
  | "hashing"
  | "resampling"
  | "quantizing"
  | "writing-large-object"
  | "committing-database"
  | "saving-archive"
  | "cleaning-up"

export type OperationState = "running" | "completed" | "failed" | "cancelled"

export interface OperationSnapshot {
  id: string
  title: string
  phase: OperationPhase
  state: OperationState
  completedBytes: number | null
  totalBytes: number | null
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

export type MixerChannelKind = "audio" | "bus" | "master"
export type MixerChannelFormat = "mono" | "stereo"
export type MixerSendTap = "pre" | "post"

export interface MixerChannelState {
  id: string
  kind: MixerChannelKind
  name: string
  color: string
  sortOrder: number
  channelFormat: MixerChannelFormat
  gainDb: number
  pan: number
  muted: boolean
  soloed: boolean
  outputChannelId: string | null
  recordArmed: boolean
  inputChannels: number[]
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
  pan: number
}

export interface MixerGraphSnapshot {
  sampleRate: number
  channels: MixerChannelState[]
  clips: TimelineClipState[]
  sends: MixerSendState[]
}

export type MixerChannelPatch = Partial<Pick<
  MixerChannelState,
  "name" | "color" | "sortOrder" | "channelFormat" | "gainDb" | "pan" |
  "muted" | "soloed" | "outputChannelId" | "recordArmed" | "inputChannels"
>>

export type MixerSendPatch = Partial<Pick<
  MixerSendState,
  "targetChannelId" | "sortOrder" | "enabled" | "tap" | "levelDb" | "pan"
>>

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
  | { type: "batch"; commands: ProjectCommand[] }

export interface ProjectCommandResult {
  graph: MixerGraphSnapshot
  inverse: ProjectCommand
}

export interface MixerParameterPreview {
  target: "channel" | "send"
  id: string
  parameter: "gainDb" | "pan" | "levelDb"
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
  | { type: "clear-meter-clips" }

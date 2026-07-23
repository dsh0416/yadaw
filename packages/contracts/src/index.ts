export const IPC_CHANNELS = {
  engineInfo: "engine:info",
  processGain: "engine:process-gain",
  audioBackends: "audio:list-backends",
  audioDevices: "audio:list-devices",
  audioStart: "audio:start",
  audioStop: "audio:stop",
  audioSnapshot: "audio:snapshot",
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
}

export type PendingRecordingState = "partial" | "ready" | "committed"

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

import type { AudioHostRuntimePreferences, ResolvedAudioHostRuntimePreferences } from "./settings"

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
    persistentPagesActive: boolean
    activationFailures: number
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
  plugins: number
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

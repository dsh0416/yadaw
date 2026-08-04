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
  audioRuntime: AudioRuntimePerformanceSnapshot | null
}

export interface AudioRuntimePerformanceSnapshot {
  sessionEpoch: string
  heartbeat: {
    ageMs: number | null
    controlGeneration: number
    tokioGeneration: number
    winitGeneration: number
    callbackGeneration: number
  }
  requests: {
    normalPending: number
    capacity: number
    slowRequests: number
  }
  runtime: {
    requested: AudioHostRuntimePreferences
    resolved: ResolvedAudioHostRuntimePreferences
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

export type AudioNativeBenchmarkKind =
  | "request-round-trip"
  | "concurrent-routing"
  | "telemetry-read"

export interface AudioNativeBenchmarkScenario {
  id: string
  label: string
  description: string
  kind: AudioNativeBenchmarkKind
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

export interface AudioNativeBenchmarkReport {
  durationMs: number
  buildProfile: "debug" | "release"
  runtime: ResolvedAudioHostRuntimePreferences
  messagePackBodyBytes: number
  scenarios: readonly AudioNativeBenchmarkScenario[]
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
  nativeBridge: AudioNativeBenchmarkReport
}

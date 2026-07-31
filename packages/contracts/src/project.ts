import type { ProjectGraphSnapshot } from "./mixer"

export const PROJECT_SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000] as const
export type ProjectSampleRate = (typeof PROJECT_SAMPLE_RATES)[number]
export type RecordingBitDepth = "float32" | "pcm24" | "pcm16"
export type ThemePreference = "light" | "dark" | "system"
export type AppLocale = "en-US" | "zh-cmn-Hans-CN"

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
  graph: ProjectGraphSnapshot
  assets: ProjectAssetSummary[]
}

export interface RecentProject {
  path: string
  name: string
  openedAt: number
}

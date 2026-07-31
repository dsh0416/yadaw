import type { AudioEngineRef, ProjectGraphRef, ProjectSessionRef, RecordingSessionRef } from "./rpc"
import type { ProjectWorkspaceSnapshot } from "./project"

export interface RecordingSession {
  id: string
  startedAt: number
  swapPath: string
  startFrame: number | null
  startTick?: number | null
  trackIds: string[]
  audioTrackIds?: string[]
  midiTrackIds?: string[]
  waitingForSync?: boolean
}

export interface RecordingDependencies {
  project: ProjectSessionRef
  projectGraph: ProjectGraphRef
  audioEngine: AudioEngineRef
}

export type RecordingStartRequest = RecordingDependencies

export interface RecordingResourceSnapshot extends RecordingDependencies {
  recording: RecordingSessionRef
  revision: number
  session: RecordingSession
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

export interface PendingMidiTake {
  trackId: string
  sourceId: string
  clipId: string
  journalPath: string
  eventCount: number
  droppedEvents: number
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
  startFrame?: number | null
  startTick?: number | null
  dropoutFrames: number
  assetExists: boolean
  recordedTracks: RecordedTrackAsset[]
  midiTakes?: PendingMidiTake[]
}

export interface RecordingStopResult {
  recording: RecordingSessionRef
  pending: PendingRecording
  recoverableMedia: boolean
  workspace: ProjectWorkspaceSnapshot
}

export interface RecordingRecoveryResult {
  pending: PendingRecording
  workspace: ProjectWorkspaceSnapshot
}

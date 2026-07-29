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

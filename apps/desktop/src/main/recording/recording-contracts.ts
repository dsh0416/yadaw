import type {
  PendingMidiTake,
  PendingRecording,
  RecordedTrackAsset,
  RecordingSession
} from "@heron/contracts"

export interface RecordingTrackSidecar {
  assetId: string
  trackId: string
  trackName: string
  inputChannels: number[]
  finalPath: string | null
  contentHash: string | null
  sampleRate: number | null
  channels: number | null
  frameCount: number | null
}

export interface RecordingSidecar extends PendingRecording {
  finalPath: string | null
  bitDepth: "float32" | "pcm24" | "pcm16"
  frameCount: number
  contentHash: string | null
  startFrame: number
  startTick: number
  tracks: RecordingTrackSidecar[]
  midiTakes: PendingMidiTake[]
  resumePlaybackAfterRecording: boolean
}

export interface RecordingSidecarRecord {
  id: string
  audioPath: string
  sidecarPath: string
  finalPath: string | null
  tracks?: { finalPath: string | null }[]
  midiTakes?: { journalPath: string }[]
}

export function utcFields(date: Date): { date: string; time: string } {
  return {
    date: date.toISOString().slice(0, 10),
    time: date.toISOString().slice(11, 19)
  }
}

export function toRecordingSession(recording: RecordingSidecar): RecordingSession {
  const audioTrackIds = recording.tracks.map((track) => track.trackId)
  const midiTrackIds = recording.midiTakes.map((take) => take.trackId)
  return {
    id: recording.id,
    startedAt: recording.startedAt,
    swapPath: recording.audioPath,
    startFrame: recording.startFrame,
    startTick: recording.startTick,
    trackIds: [...audioTrackIds, ...midiTrackIds],
    audioTrackIds,
    midiTrackIds
  }
}

export function toPendingRecording(recording: RecordingSidecar): PendingRecording {
  const {
    id,
    state,
    audioPath,
    sidecarPath,
    projectPath,
    sampleRate,
    channels,
    startedAt,
    dropoutFrames,
    assetExists,
    startFrame,
    startTick,
    audioTrackIds,
    midiTrackIds,
    midiTakes
  } = recording
  const recordedTracks: RecordedTrackAsset[] = (recording.tracks ?? [])
    .filter(
      (track) => track.sampleRate !== null && track.channels !== null && track.frameCount !== null
    )
    .map((track) => ({
      assetId: track.assetId,
      trackId: track.trackId,
      name: `Recording ${track.trackName}`,
      sampleRate: track.sampleRate!,
      channels: track.channels!,
      frameCount: track.frameCount!
    }))
  return {
    id,
    state,
    audioPath,
    sidecarPath,
    projectPath,
    sampleRate,
    channels,
    startedAt,
    startFrame,
    startTick,
    audioTrackIds,
    midiTrackIds,
    dropoutFrames,
    assetExists,
    recordedTracks,
    midiTakes: midiTakes ?? []
  }
}

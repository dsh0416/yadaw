import type { BinaryPayloadWire } from "./binary"

export interface AudioHostRecordingConfig {
  path: string
  assetId: string
  originator: string
  originationDate: string
  originationTime: string
  timeReference: number
  sampleRate: number
  channels: number
}

export interface AudioHostRecordingResultWire {
  path: string
  sample_rate: number
  channels: number
  frame_count: number
  dropout_frames: number
}

export interface AudioHostMidiRecordingTakeConfig {
  path: string
  sourceId: string
  clipId: string
  trackId: string
  portId: string | null
  channel: number | null
}

export interface AudioHostMidiRecordingConfig {
  takes: AudioHostMidiRecordingTakeConfig[]
}

export interface AudioHostMidiRecordingTakeResultWire {
  path: string
  source_id: string
  clip_id: string
  track_id: string
  event_count: number
  dropped_events: number
}

export interface AudioHostMidiRecordingResultWire {
  takes: AudioHostMidiRecordingTakeResultWire[]
}

export interface AudioHostMidiRecordingTakeResult {
  path: string
  sourceId: string
  clipId: string
  trackId: string
  eventCount: number
  droppedEvents: number
}

export interface AudioHostMidiRecordingResult {
  takes: AudioHostMidiRecordingTakeResult[]
}

export interface AudioHostWaveformWire {
  sample_rate: number
  channels: number
  frame_count: number
  start_frame: number
  end_frame: number
  frames_per_bucket: number
  bucket_count: number
  peaks: BinaryPayloadWire
}

export interface AudioHostRecordingResult {
  path: string
  sampleRate: number
  channels: number
  frameCount: number
  dropoutFrames: number
}

export interface AudioHostWaveform {
  sampleRate: number
  channels: number
  frameCount: number
  startFrame: number
  endFrame: number
  framesPerBucket: number
  bucketCount: number
  peaks: Uint8Array
}

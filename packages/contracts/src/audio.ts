import type { ProjectLifecycleState } from "./project"
import type { RecordingLifecycleState } from "./recording"

// "mock" is a cpal custom host that synthesises capture and discards playback.
// It is always available and is listed last so it is only auto-selected when no
// hardware backend can be reached.
export const AUDIO_BACKENDS = ["wasapi", "asio", "coreaudio", "alsa", "mock"] as const
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
  outputSampleRate: number | null
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

export interface RoundTripLatencyMeasurementRequest {
  inputChannel: number
  outputChannel: number
}

export type RoundTripLatencyMeasurementStatus =
  "idle" | "preparing" | "measuring" | "complete" | "failed"

export type RoundTripLatencyMeasurementFailure = "input-too-loud" | "signal-not-detected"

export interface RoundTripLatencyMeasurement {
  status: RoundTripLatencyMeasurementStatus
  inputChannel: number | null
  outputChannel: number | null
  measuredRoundTripLatencyMs: number | null
  failure: RoundTripLatencyMeasurementFailure | null
}

export const INITIAL_AUDIO_RUNTIME_SNAPSHOT: Readonly<AudioRuntimeSnapshot> = {
  state: "stopped",
  requestedBufferSize: null,
  sampleRate: null,
  inputSampleRate: null,
  outputSampleRate: null,
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

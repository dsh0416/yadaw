import { binaryBytes } from "./wire"
import type {
  AudioHostMidiRecordingConfig,
  AudioHostMidiRecordingResult,
  AudioHostRecordingConfig,
  AudioHostRecordingResult,
  AudioHostWaveform,
  ControlResponse
} from "./wire"

export class AudioHostRecordingClient {
  constructor(
    private readonly request: (command: Record<string, unknown>) => Promise<ControlResponse>
  ) {}

  startRecording(config: AudioHostRecordingConfig): Promise<void> {
    return this.request({
      type: "start-recording",
      config: {
        path: config.path,
        asset_id: config.assetId,
        originator: config.originator,
        origination_date: config.originationDate,
        origination_time: config.originationTime,
        time_reference: config.timeReference,
        sample_rate: config.sampleRate,
        channels: config.channels
      }
    }).then(() => undefined)
  }

  async stopRecording(): Promise<AudioHostRecordingResult> {
    const response = await this.request({ type: "stop-recording" })
    if (response.result.type !== "recording-stopped" || !response.result.recording) {
      throw new Error("audio host returned an invalid recording result")
    }
    const recording = response.result.recording
    return {
      path: recording.path,
      sampleRate: recording.sample_rate,
      channels: recording.channels,
      frameCount: recording.frame_count,
      dropoutFrames: recording.dropout_frames
    }
  }

  startMidiRecording(config: AudioHostMidiRecordingConfig): Promise<void> {
    return this.request({
      type: "start-midi-recording",
      config: {
        takes: config.takes.map((take) => ({
          path: take.path,
          source_id: take.sourceId,
          clip_id: take.clipId,
          track_id: take.trackId,
          port_id: take.portId,
          channel: take.channel
        }))
      }
    }).then(() => undefined)
  }

  async stopMidiRecording(): Promise<AudioHostMidiRecordingResult> {
    const response = await this.request({ type: "stop-midi-recording" })
    if (response.result.type !== "midi-recording-stopped" || !response.result.midi_recording) {
      throw new Error("audio host returned an invalid MIDI recording result")
    }
    return {
      takes: response.result.midi_recording.takes.map((take) => ({
        path: take.path,
        sourceId: take.source_id,
        clipId: take.clip_id,
        trackId: take.track_id,
        eventCount: take.event_count,
        droppedEvents: take.dropped_events
      }))
    }
  }

  async recordingWaveform(
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<AudioHostWaveform> {
    const response = await this.request({
      type: "recording-waveform",
      start_frame: startFrame,
      end_frame: endFrame,
      max_buckets: maxBuckets
    })
    if (response.result.type !== "recording-waveform" || !response.result.waveform) {
      throw new Error("audio host returned an invalid recording waveform")
    }
    const waveform = response.result.waveform
    return {
      sampleRate: waveform.sample_rate,
      channels: waveform.channels,
      frameCount: waveform.frame_count,
      startFrame: waveform.start_frame,
      endFrame: waveform.end_frame,
      framesPerBucket: waveform.frames_per_bucket,
      bucketCount: waveform.bucket_count,
      peaks: binaryBytes(waveform.peaks)
    }
  }
}

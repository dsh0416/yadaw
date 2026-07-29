import { binaryBytes } from "./audio-host-wire"
import type {
  AudioHostRecordingConfig,
  AudioHostRecordingResult,
  AudioHostWaveform,
  ControlResponse
} from "./audio-host-wire"

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
        time_reference: config.timeReference
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

import { effectScope, shallowRef } from "vue"
import { describe, expect, it } from "vitest"
import type { MixerChannelState } from "@heron/contracts"
import { useArrangementTrackProjection } from "./useArrangementTrackProjection"

const channel: MixerChannelState = {
  id: "audio-1",
  kind: "audio",
  systemRole: null,
  name: "Audio 1",
  color: "#8c83ff",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "stereo",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1, 2],
  hardwareOutputChannels: []
}

describe("useArrangementTrackProjection", () => {
  it("joins clips, dimensions and a missing-meter fallback into one readonly row", () => {
    const tracks = shallowRef([{ ...channel, trackId: "track-1", sortOrder: 0 }])
    const scope = effectScope()
    const projection = scope.run(() =>
      useArrangementTrackProjection({
        tracks: () => tracks.value,
        audioClips: () => [
          {
            id: "clip-1",
            trackId: "track-1",
            name: "Take",
            startSeconds: 0,
            durationSeconds: 1,
            endSeconds: 1,
            channels: 2,
            sampleRate: 48_000,
            projectSampleRate: 48_000,
            startFrame: 0,
            sourceOffsetFrames: 0,
            lengthFrames: 48_000,
            sourceLengthFrames: 48_000,
            fadeInFrames: 0,
            fadeOutFrames: 0,
            assetId: "asset-1"
          }
        ],
        midiClips: () => [],
        trackScale: () => 1.5,
        trackHeight: () => 132,
        meterFor: () => undefined
      })
    )!

    expect(projection.rows.value).toHaveLength(1)
    expect(projection.rows.value[0]).toMatchObject({
      scale: 1.5,
      height: 132,
      meter: { channelId: "audio-1", clipped: false }
    })
    expect(projection.rows.value[0]?.audioClips.map((clip) => clip.id)).toEqual(["clip-1"])
    scope.stop()
  })
})

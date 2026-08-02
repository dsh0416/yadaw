import { describe, expect, it } from "vitest"
import type { AudioClipState, MidiClipState } from "@yadaw/contracts"
import {
  planAudioClipFade,
  planAudioClipSplit,
  planAudioClipTrim,
  planMidiClipSplits,
  planMidiClipTrim,
  previewAudioClipTrim,
  previewMidiClipTrim,
  projectFrameToAssetFrame
} from "./clipEditing"

function clip(overrides: Partial<MidiClipState> = {}): MidiClipState {
  return {
    id: "clip-1",
    sourceId: "source-1",
    trackId: "track-1",
    name: "Verse",
    startTick: 1_000,
    sourceOffsetTicks: 200,
    lengthTicks: 800,
    sourceLengthTicks: 1_600,
    notes: [
      {
        id: "note-1",
        startTick: 300,
        durationTicks: 120,
        channel: 0,
        key: 60,
        velocity: 100,
        releaseVelocity: 0
      }
    ],
    events: [
      {
        id: "event-1",
        tick: 400,
        channel: 0,
        kind: "control-change",
        data: new Uint8Array([1, 64])
      }
    ],
    ...overrides
  }
}

function audioClip(overrides: Partial<AudioClipState> = {}): AudioClipState {
  return {
    id: "audio-1",
    assetId: "asset-1",
    trackId: "track-1",
    name: "Take",
    startFrame: 1_000,
    sourceOffsetFrames: 200,
    lengthFrames: 800,
    sourceLengthFrames: 1_600,
    fadeInFrames: 100,
    fadeOutFrames: 120,
    assetSampleRate: 96_000,
    assetChannels: 2,
    ...overrides
  }
}

describe("arrangement audio clip editing", () => {
  it("trims within source bounds and keeps fades valid", () => {
    const value = audioClip()

    expect(previewAudioClipTrim(value, "start", 1_750)).toMatchObject({
      startFrame: 1_750,
      sourceOffsetFrames: 950,
      lengthFrames: 50,
      fadeInFrames: 0,
      fadeOutFrames: 50
    })
    expect(previewAudioClipTrim(value, "start", 0)).toMatchObject({
      startFrame: 800,
      sourceOffsetFrames: 0,
      lengthFrames: 1_000
    })
    expect(previewAudioClipTrim(value, "end", 9_999)).toMatchObject({ lengthFrames: 1_400 })
    expect(planAudioClipTrim(value, "end", 1_800)).toBeNull()
  })

  it("splits as one batch, preserving only the outer fades", () => {
    expect(planAudioClipSplit(audioClip(), 1_400, () => "audio-2")).toEqual({
      type: "batch",
      commands: [
        {
          type: "update-audio-clip",
          clipId: "audio-1",
          patch: { lengthFrames: 400, fadeInFrames: 100, fadeOutFrames: 0 }
        },
        {
          type: "create-audio-clip",
          clip: expect.objectContaining({
            id: "audio-2",
            startFrame: 1_400,
            sourceOffsetFrames: 600,
            lengthFrames: 400,
            fadeInFrames: 0,
            fadeOutFrames: 120
          })
        }
      ]
    })
  })

  it("clamps fades and converts project source frames to native asset frames", () => {
    expect(planAudioClipFade(audioClip(), "in", 750)).toEqual({
      type: "update-audio-clip",
      clipId: "audio-1",
      patch: { fadeInFrames: 680 }
    })
    expect(planAudioClipFade(audioClip(), "out", 120)).toBeNull()
    expect(planAudioClipFade(audioClip(), "out", 0)).toEqual({
      type: "update-audio-clip",
      clipId: "audio-1",
      patch: { fadeOutFrames: 0 }
    })
    expect(planAudioClipSplit(audioClip(), 1_000)).toBeNull()
    expect(planAudioClipSplit(audioClip(), 1_800)).toBeNull()
    expect(planAudioClipTrim(audioClip(), "start", 1_000)).toBeNull()
    expect(projectFrameToAssetFrame(240, 48_000, 96_000)).toBe(480)
    expect(projectFrameToAssetFrame(241, 48_000, 44_100, "ceil")).toBe(222)
  })
})

describe("arrangement MIDI clip editing", () => {
  it("trims and re-extends both edges within preserved source bounds", () => {
    const value = clip()

    expect(previewMidiClipTrim(value, "start", 1_240)).toMatchObject({
      startTick: 1_240,
      sourceOffsetTicks: 440,
      lengthTicks: 560
    })
    expect(previewMidiClipTrim(value, "start", 0)).toMatchObject({
      startTick: 800,
      sourceOffsetTicks: 0,
      lengthTicks: 1_000
    })
    expect(previewMidiClipTrim(value, "end", 9_999)).toMatchObject({
      startTick: 1_000,
      sourceOffsetTicks: 200,
      lengthTicks: 1_400
    })
    expect(planMidiClipTrim(value, "end", 1_800)).toBeNull()
  })

  it("splits selected clips as one batch and clones hidden content with new IDs", () => {
    let nextId = 0

    const command = planMidiClipSplits(
      [clip(), clip({ id: "outside", startTick: 2_000 })],
      1_400,
      () => String(++nextId)
    )

    expect(command).toEqual({
      type: "batch",
      commands: [
        {
          type: "update-midi-clip-range",
          clipId: "clip-1",
          patch: { lengthTicks: 400 }
        },
        {
          type: "create-midi-clip",
          clip: expect.objectContaining({
            id: "1",
            startTick: 1_400,
            sourceOffsetTicks: 600,
            lengthTicks: 400,
            sourceLengthTicks: 1_600,
            notes: [expect.objectContaining({ id: "2" })],
            events: [expect.objectContaining({ id: "3", data: new Uint8Array([1, 64]) })]
          })
        }
      ]
    })
    expect(planMidiClipSplits([clip()], 1_000)).toBeNull()
    expect(planMidiClipTrim(clip(), "start", 1_000)).toBeNull()
  })
})

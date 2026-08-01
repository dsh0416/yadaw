import { describe, expect, it } from "vitest"
import type { MidiClipState } from "@yadaw/contracts"
import { planMidiClipSplits, planMidiClipTrim, previewMidiClipTrim } from "./clipEditing"

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
  })
})

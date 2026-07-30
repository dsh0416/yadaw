import { describe, expect, it } from "vitest"
import type { MidiClipState } from "@yadaw/contracts"
import {
  MIN_NOTE_TICKS,
  midiNoteName,
  noteGlobalStart,
  planCreatedNotes,
  planExistingNoteEdits,
  quantizeNoteStarts,
  snapTicks
} from "./pianoRoll"

const clip: MidiClipState = {
  id: "clip-1",
  sourceId: "source-1",
  trackId: "instrument-1",
  name: "Keys",
  startTick: 960,
  lengthTicks: 960,
  sourceOffsetTicks: 0,
  notes: [
    {
      id: "note-1",
      startTick: 120,
      durationTicks: 240,
      channel: 0,
      key: 60,
      velocity: 100,
      releaseVelocity: 0
    },
    {
      id: "note-2",
      startTick: 480,
      durationTicks: 240,
      channel: 0,
      key: 64,
      velocity: 96,
      releaseVelocity: 0
    }
  ],
  events: [{ id: "event-1", tick: 240, channel: 0, kind: "control-change", data: new Uint8Array() }]
}

describe("piano roll timing", () => {
  it("uses one integer tick as the finest 1/3840-note resolution", () => {
    expect(MIN_NOTE_TICKS).toBe(1)
    expect(snapTicks(12.6, "off")).toBe(13)
    expect(snapTicks(350, "1/16")).toBe(240)
    expect(snapTicks(400, "1/8T")).toBe(320)
  })

  it("maps source-relative note positions into arrangement-global ticks", () => {
    expect(noteGlobalStart(clip, clip.notes[0]!)).toBe(1_080)
  })

  it("grows and rebases a clip left without moving untouched content", () => {
    const plan = planExistingNoteEdits(clip, [
      { noteId: "note-1", globalStartTick: 720, durationTicks: 240 }
    ])
    expect(plan.startTick).toBe(720)
    expect(plan.sourceOffsetTicks).toBe(0)
    expect(plan.lengthTicks).toBe(1_200)
    expect(plan.commands.map((command) => command.type)).toEqual([
      "rebase-midi-clip-content",
      "update-midi-clip-range",
      "update-midi-notes"
    ])
    expect(plan.commands[0]).toEqual({
      type: "rebase-midi-clip-content",
      clipId: "clip-1",
      deltaTicks: 240
    })
  })

  it("extends the right edge for newly created notes and preserves integer duration", () => {
    const plan = planCreatedNotes(clip, [
      {
        id: "new-note",
        globalStartTick: 2_100,
        durationTicks: 0.4,
        channel: 0,
        key: 67,
        velocity: 100,
        releaseVelocity: 0
      }
    ])
    expect(plan.lengthTicks).toBe(1_141)
    expect(plan.commands.at(-1)).toEqual({
      type: "create-midi-notes",
      clipId: "clip-1",
      notes: [
        expect.objectContaining({
          id: "new-note",
          startTick: 1_140,
          durationTicks: 1
        })
      ]
    })
  })

  it("quantizes note starts to the snap grid and drops already-aligned notes", () => {
    const quantized = quantizeNoteStarts(
      [
        { noteId: "note-1", globalStartTick: 1_060 },
        { noteId: "note-2", globalStartTick: 960 },
        { noteId: "note-3", globalStartTick: 1_339 }
      ],
      "1/16"
    )
    expect(quantized).toEqual([
      { noteId: "note-1", globalStartTick: 960 },
      { noteId: "note-3", globalStartTick: 1_440 }
    ])
  })

  it("does not quantize when snapping is off", () => {
    expect(quantizeNoteStarts([{ globalStartTick: 1_060.4 }], "off")).toEqual([])
  })
})

describe("midi note naming", () => {
  it("labels middle C as C4 under the Roland standard by default", () => {
    expect(midiNoteName(60)).toBe("C4")
    expect(midiNoteName(60, "roland-c4")).toBe("C4")
    expect(midiNoteName(72, "roland-c4")).toBe("C5")
  })

  it("labels middle C as C3 under the Yamaha standard", () => {
    expect(midiNoteName(60, "yamaha-c3")).toBe("C3")
    expect(midiNoteName(72, "yamaha-c3")).toBe("C4")
    expect(midiNoteName(61, "yamaha-c3")).toBe("C♯3")
  })
})

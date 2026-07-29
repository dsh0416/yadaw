import { describe, expect, it } from "vitest"
import type { MixerGraphSnapshot, ProjectCommand } from "@yadaw/contracts"
import { applyToGraph, inverseFor, validateGraph } from "./mixer-graph"

function graph(): MixerGraphSnapshot {
  return {
    sampleRate: 48_000,
    channels: [
      {
        id: "instrument-1",
        kind: "instrument",
        systemRole: null,
        name: "Instrument 1",
        color: "#73D6A2",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        outputBus: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "master",
        kind: "master",
        systemRole: null,
        name: "Master",
        color: "#8C83FF",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        outputBus: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        systemRole: null,
        name: "Output",
        color: "#EF7C95",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        outputBus: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ],
    clips: [],
    sends: [],
    plugins: [],
    midiClips: [
      {
        id: "clip-1",
        sourceId: "source-1",
        trackId: "instrument-1",
        name: "Clip",
        startTick: 0,
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
          }
        ],
        events: []
      }
    ],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    },
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
  }
}

describe("MIDI note project commands", () => {
  it("creates a blank MIDI source and clip as one invertible batch", () => {
    const before = graph()
    const source = {
      id: "blank-source",
      name: "MIDI Clip 2",
      contentHash: "blank:blank-source",
      rawBytes: new Uint8Array()
    }
    const command: ProjectCommand = {
      type: "batch",
      commands: [
        { type: "create-midi-source", source },
        {
          type: "create-midi-clip",
          clip: {
            id: "clip-2",
            sourceId: source.id,
            trackId: "instrument-1",
            name: source.name,
            startTick: 960,
            lengthTicks: 3_840,
            sourceOffsetTicks: 0,
            notes: [],
            events: []
          }
        }
      ]
    }
    const inverse = inverseFor(before, command)
    const after = applyToGraph(before, command)

    validateGraph(after)
    expect(after.midiClips).toContainEqual(expect.objectContaining({ id: "clip-2" }))
    expect(inverse).toEqual({
      type: "batch",
      commands: [
        { type: "delete-midi-clip", clipId: "clip-2" },
        { type: "delete-midi-source", source }
      ]
    })
    expect(applyToGraph(after, inverse)).toEqual(before)
  })

  it("applies and inverts integer-tick note edits", () => {
    const before = graph()
    const command: ProjectCommand = {
      type: "update-midi-notes",
      clipId: "clip-1",
      updates: [{ noteId: "note-1", patch: { startTick: 121, durationTicks: 1 } }]
    }
    const inverse = inverseFor(before, command)
    const after = applyToGraph(before, command)

    validateGraph(after)
    expect(after.midiClips[0]?.notes[0]).toEqual(
      expect.objectContaining({ startTick: 121, durationTicks: 1 })
    )
    expect(applyToGraph(after, inverse)).toEqual(before)
  })

  it("rebases notes and events with an exactly invertible integer delta", () => {
    const before = graph()
    before.midiClips[0]!.events.push({
      id: "event-1",
      tick: 80,
      channel: 0,
      kind: "control-change",
      data: new Uint8Array([1, 2])
    })
    const command: ProjectCommand = {
      type: "rebase-midi-clip-content",
      clipId: "clip-1",
      deltaTicks: 40
    }
    const after = applyToGraph(before, command)

    expect(after.midiClips[0]?.notes[0]?.startTick).toBe(160)
    expect(after.midiClips[0]?.events[0]?.tick).toBe(120)
    expect(applyToGraph(after, inverseFor(before, command))).toEqual(before)
  })

  it("rejects fractional and duplicate note timing identities", () => {
    const value = graph()
    value.midiClips[0]!.notes[0]!.startTick = 0.5
    expect(() => validateGraph(value)).toThrow("MIDI note contains invalid")

    value.midiClips[0]!.notes[0]!.startTick = 0
    value.midiClips[0]!.notes.push({ ...value.midiClips[0]!.notes[0]! })
    expect(() => validateGraph(value)).toThrow("MIDI note IDs must be unique")
  })
})

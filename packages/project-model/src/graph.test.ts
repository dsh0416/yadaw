import { describe, expect, it } from "vitest"
import type {
  PluginDescriptor,
  PluginInstanceState,
  ProjectGraphSnapshot,
  ProjectCommand
} from "@yadaw/contracts"
import {
  applyToGraph,
  deletedChannelIds,
  inverseFor,
  onlyRealtimeParameters,
  validateGraph
} from "./graph"
import { projectContentEndSeconds } from "./selectors"

const effectDescriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "effect-class",
  modulePath: "/plugins/Effect.vst3",
  name: "Effect",
  vendor: "YADAW",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["stereo"],
  hasEditor: false,
  compatibility: "compatible",
  compatibilityReason: null
}

function plugin(overrides: Partial<PluginInstanceState> = {}): PluginInstanceState {
  return {
    id: "plugin-1",
    channelId: "instrument-1",
    role: "insert",
    slotOrder: 0,
    classId: effectDescriptor.classId,
    descriptor: effectDescriptor,
    audioMode: "stereo",
    enabled: true,
    componentState: new Uint8Array([1]),
    controllerState: new Uint8Array([2]),
    ...overrides
  }
}

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [{ id: "track:instrument-1", channelId: "instrument-1", sortOrder: 0 }],
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
    audioClips: [],
    sends: [],
    plugins: [],
    midiClips: [
      {
        id: "clip-1",
        sourceId: "source-1",
        trackId: "track:instrument-1",
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
            trackId: "track:instrument-1",
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

describe("project graph command characterization", () => {
  it("selects the transport content end across audio frames and musical ticks", () => {
    const value = graph()
    value.audioClips.push({
      id: "audio-clip",
      assetId: "asset",
      trackId: "track:audio",
      name: "Audio",
      startFrame: 48_000,
      sourceOffsetFrames: 0,
      lengthFrames: 24_000,
      assetSampleRate: 48_000,
      assetChannels: 2
    })

    expect(projectContentEndSeconds(value)).toBe(1.5)
  })

  it("creates and deletes a track with its channel as one invertible aggregate", () => {
    const before = graph()
    const channel = {
      ...structuredClone(before.channels[0]!),
      id: "instrument-2",
      name: "Instrument 2",
      sortOrder: 1
    }
    const command: ProjectCommand = {
      type: "create-track",
      track: { id: "track:instrument-2", channelId: channel.id, sortOrder: 1 },
      channel
    }

    const after = applyToGraph(before, command)

    validateGraph(after)
    expect(after.tracks).toContainEqual({
      id: "track:instrument-2",
      channelId: "instrument-2",
      sortOrder: 1
    })
    expect(after.channels).toContainEqual(channel)
    expect(applyToGraph(after, inverseFor(before, command))).toEqual(before)
  })

  it("enforces track ownership independently from mixer channel order", () => {
    const missingTrack = graph()
    missingTrack.tracks = []
    expect(() => validateGraph(missingTrack)).toThrow(
      "Ordinary Audio and Instrument channels require exactly one project track"
    )

    const systemTrack = graph()
    systemTrack.tracks.push({ id: "track:master", channelId: "master", sortOrder: 99 })
    expect(() => validateGraph(systemTrack)).toThrow(
      "Project tracks must reference ordinary Audio or Instrument channels"
    )

    const value = graph()
    value.tracks[0]!.sortOrder = 12
    value.channels[0]!.sortOrder = 3
    expect(() => validateGraph(value)).not.toThrow()
  })

  it("round-trips non-MIDI edits through one inverse batch", () => {
    const before = graph()
    const command: ProjectCommand = {
      type: "batch",
      commands: [
        {
          type: "update-channel",
          channelId: "instrument-1",
          patch: { name: "Lead", gainDb: -6, pan: 0.25 }
        },
        {
          type: "replace-tempo-map",
          tempoMap: {
            ticksPerQuarter: 960,
            tempoEvents: [
              { tick: 0, beatsPerMinute: 100 },
              { tick: 1_920, beatsPerMinute: 140 }
            ],
            timeSignatureEvents: [{ tick: 0, numerator: 3, denominator: 4 }]
          }
        },
        {
          type: "replace-key-signature-map",
          events: [
            { tick: 0, fifths: -3, mode: "minor" },
            { tick: 3_840, fifths: 2, mode: "major" }
          ]
        }
      ]
    }

    const inverse = inverseFor(before, command)
    const after = applyToGraph(before, command)

    validateGraph(after)
    expect(after.channels.find(({ id }) => id === "instrument-1")).toMatchObject({
      name: "Lead",
      gainDb: -6,
      pan: 0.25
    })
    expect(after.tempoMap.tempoEvents).toHaveLength(2)
    expect(after.keySignatureEvents).toHaveLength(2)
    expect(applyToGraph(after, inverse)).toEqual(before)
  })
})

describe("additional project graph commands", () => {
  it("updates and deletes tracks invertibly", () => {
    const before = graph()
    const updateCommand: ProjectCommand = {
      type: "update-track",
      trackId: "track:instrument-1",
      patch: { sortOrder: 7 }
    }
    const updated = applyToGraph(before, updateCommand)
    expect(updated.tracks[0]?.sortOrder).toBe(7)
    expect(applyToGraph(updated, inverseFor(before, updateCommand))).toEqual(before)

    const deleteCommand: ProjectCommand = {
      type: "delete-track",
      trackId: "track:instrument-1"
    }
    const deleted = applyToGraph(before, deleteCommand)
    expect(deleted.tracks).toEqual([])
    expect(deleted.channels.some((channel) => channel.id === "instrument-1")).toBe(false)
    expect(deleted.midiClips).toEqual([])
    const restored = applyToGraph(deleted, inverseFor(before, deleteCommand))
    expect(restored.tracks).toEqual(before.tracks)
    expect(restored.midiClips).toEqual(before.midiClips)
    expect(restored.channels).toEqual(expect.arrayContaining(before.channels))
  })


  it("creates, updates, and deletes aux channels and sends invertibly", () => {
    const before = graph()
    const aux = {
      ...structuredClone(before.channels[0]!),
      id: "aux-1",
      kind: "aux" as const,
      name: "Aux",
      inputSource: "bus" as const,
      inputFormat: "mono" as const,
      inputChannels: [1],
      outputChannelId: "output",
      midiInput: undefined
    }
    const withAux = applyToGraph(before, { type: "create-channel", channel: aux })
    expect(withAux.channels).toContainEqual(aux)

    const send = {
      id: "send-1",
      sourceChannelId: "instrument-1",
      targetChannelId: null,
      targetBus: 1,
      sortOrder: 0,
      enabled: true,
      tap: "post" as const,
      levelDb: -6
    }
    const withSend = applyToGraph(withAux, { type: "create-send", send })
    const updateSend: ProjectCommand = {
      type: "update-send",
      sendId: "send-1",
      patch: { levelDb: -3, enabled: false }
    }
    const updatedSend = applyToGraph(withSend, updateSend)
    expect(updatedSend.sends[0]).toMatchObject({ levelDb: -3, enabled: false })
    expect(applyToGraph(updatedSend, inverseFor(withSend, updateSend))).toEqual(withSend)

    const deleteSend: ProjectCommand = { type: "delete-send", sendId: "send-1" }
    const withoutSend = applyToGraph(updatedSend, deleteSend)
    expect(withoutSend.sends).toEqual([])
    expect(applyToGraph(withoutSend, inverseFor(updatedSend, deleteSend))).toEqual(updatedSend)

    const deleteChannel: ProjectCommand = { type: "delete-channel", channelId: "aux-1" }
    const withoutAux = applyToGraph(withAux, deleteChannel)
    expect(withoutAux.channels.some((channel) => channel.id === "aux-1")).toBe(false)
    expect(applyToGraph(withoutAux, inverseFor(withAux, deleteChannel))).toEqual(withAux)
  })

  it("round-trips audio clip create/move/delete", () => {
    const before = graph()
    before.tracks.push({ id: "track:audio-1", channelId: "audio-1", sortOrder: 1 })
    before.channels.push({
      ...structuredClone(before.channels[0]!),
      id: "audio-1",
      kind: "audio",
      name: "Audio",
      inputSource: "hardware",
      inputFormat: "stereo",
      inputChannels: [1, 2],
      midiInput: undefined
    })
    const clip = {
      id: "audio-clip-1",
      assetId: "asset-1",
      trackId: "track:audio-1",
      name: "Take",
      startFrame: 0,
      sourceOffsetFrames: 0,
      lengthFrames: 480,
      assetSampleRate: 48_000,
      assetChannels: 2
    }
    const created = applyToGraph(before, { type: "create-audio-clip", clip })
    const moveCommand: ProjectCommand = {
      type: "move-audio-clip",
      clipId: "audio-clip-1",
      trackId: "track:audio-1",
      startFrame: 960
    }
    const moved = applyToGraph(created, moveCommand)
    expect(moved.audioClips[0]?.startFrame).toBe(960)
    expect(applyToGraph(moved, inverseFor(created, moveCommand))).toEqual(created)

    const deleteCommand: ProjectCommand = {
      type: "delete-audio-clip",
      clipId: "audio-clip-1"
    }
    const deleted = applyToGraph(moved, deleteCommand)
    expect(deleted.audioClips).toEqual([])
    expect(applyToGraph(deleted, inverseFor(moved, deleteCommand))).toEqual(moved)
  })

  it("round-trips plugin create/update/move/replace/delete", () => {
    const before = graph()
    const created = applyToGraph(before, { type: "create-plugin", plugin: plugin() })
    const updated = applyToGraph(created, {
      type: "update-plugin",
      pluginId: "plugin-1",
      patch: { enabled: false, slotOrder: 0 }
    })
    expect(updated.plugins[0]?.enabled).toBe(false)

    const second = plugin({ id: "plugin-2", slotOrder: 1 })
    const withTwo = applyToGraph(updated, { type: "create-plugin", plugin: second })
    const moved = applyToGraph(withTwo, {
      type: "move-plugin",
      pluginId: "plugin-2",
      channelId: "instrument-1",
      role: "insert",
      slotOrder: 0
    })
    expect(moved.plugins.find((candidate) => candidate.id === "plugin-2")?.slotOrder).toBe(0)

    const replacement = plugin({
      id: "plugin-1",
      enabled: true,
      componentState: new Uint8Array([9])
    })
    const replaceCommand: ProjectCommand = {
      type: "replace-plugin",
      pluginId: "plugin-1",
      plugin: replacement
    }
    const replaced = applyToGraph(created, replaceCommand)
    expect(replaced.plugins[0]?.componentState).toEqual(new Uint8Array([9]))
    expect(applyToGraph(replaced, inverseFor(created, replaceCommand))).toEqual(created)

    const deleteCommand: ProjectCommand = { type: "delete-plugin", pluginId: "plugin-1" }
    const deleted = applyToGraph(created, deleteCommand)
    expect(deleted.plugins).toEqual([])
    expect(applyToGraph(deleted, inverseFor(created, deleteCommand))).toEqual(created)
  })

  it("round-trips midi clip range, move, notes, and source delete no-ops", () => {
    const before = graph()
    const rangeCommand: ProjectCommand = {
      type: "update-midi-clip-range",
      clipId: "clip-1",
      patch: { lengthTicks: 1_920, sourceOffsetTicks: 10 }
    }
    const ranged = applyToGraph(before, rangeCommand)
    expect(ranged.midiClips[0]).toMatchObject({ lengthTicks: 1_920, sourceOffsetTicks: 10 })
    expect(applyToGraph(ranged, inverseFor(before, rangeCommand))).toEqual(before)

    const withNotes = applyToGraph(before, {
      type: "create-midi-notes",
      clipId: "clip-1",
      notes: [
        {
          id: "note-2",
          startTick: 480,
          durationTicks: 120,
          channel: 0,
          key: 64,
          velocity: 90,
          releaseVelocity: 0
        }
      ]
    })
    expect(withNotes.midiClips[0]?.notes).toHaveLength(2)
    const deleteNotes: ProjectCommand = {
      type: "delete-midi-notes",
      clipId: "clip-1",
      noteIds: ["note-2"]
    }
    const withoutNote = applyToGraph(withNotes, deleteNotes)
    expect(withoutNote.midiClips[0]?.notes.map((note) => note.id)).toEqual(["note-1"])
    expect(applyToGraph(withoutNote, inverseFor(withNotes, deleteNotes))).toEqual(withNotes)

    const moved = applyToGraph(before, {
      type: "move-midi-clip",
      clipId: "clip-1",
      trackId: "track:instrument-1",
      startTick: 480
    })
    expect(moved.midiClips[0]?.startTick).toBe(480)

    const source = {
      id: "source-1",
      name: "Source",
      contentHash: "hash",
      rawBytes: new Uint8Array()
    }
    expect(applyToGraph(before, { type: "delete-midi-source", source })).toEqual(before)
    expect(inverseFor(before, { type: "delete-midi-source", source })).toEqual({
      type: "create-midi-source",
      source
    })

    const deleteClip: ProjectCommand = { type: "delete-midi-clip", clipId: "clip-1" }
    const withoutClip = applyToGraph(before, deleteClip)
    expect(withoutClip.midiClips).toEqual([])
    expect(applyToGraph(withoutClip, inverseFor(before, deleteClip))).toEqual(before)
  })

  it("classifies realtime parameter patches and deleted channel ids", () => {
    expect(
      onlyRealtimeParameters({
        type: "update-channel",
        channelId: "instrument-1",
        patch: { gainDb: -3, pan: 0.1 }
      })
    ).toBe(true)
    expect(
      onlyRealtimeParameters({
        type: "update-channel",
        channelId: "instrument-1",
        patch: { name: "Lead" }
      })
    ).toBe(false)
    expect(
      onlyRealtimeParameters({
        type: "batch",
        commands: [
          { type: "replace-key-signature-map", events: [{ tick: 0, fifths: 0, mode: "major" }] },
          { type: "update-send", sendId: "send", patch: { levelDb: -6 } }
        ]
      })
    ).toBe(true)
    expect(
      onlyRealtimeParameters({
        type: "create-send",
        send: {
          id: "send",
          sourceChannelId: "instrument-1",
          targetBus: 1,
          sortOrder: 0,
          enabled: true,
          tap: "post",
          levelDb: 0
        }
      })
    ).toBe(false)

    const value = graph()
    expect([
      ...deletedChannelIds(value, { type: "delete-track", trackId: "track:instrument-1" })
    ]).toEqual(["instrument-1"])
    expect([...deletedChannelIds(value, { type: "delete-channel", channelId: "output" })]).toEqual([
      "output"
    ])
    expect(
      [
        ...deletedChannelIds(value, {
          type: "batch",
          commands: [
            { type: "delete-track", trackId: "track:instrument-1" },
            { type: "update-channel", channelId: "master", patch: { gainDb: -1 } }
          ]
        })
      ].sort()
    ).toEqual(["instrument-1"])
    expect([
      ...deletedChannelIds(value, { type: "update-channel", channelId: "master", patch: {} })
    ]).toEqual([])
  })
})

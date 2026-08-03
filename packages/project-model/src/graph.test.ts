import { describe, expect, it } from "vitest"
import type {
  PluginDescriptor,
  PluginInstanceState,
  ProjectGraphSnapshot,
  ProjectCommand
} from "@yadaw/contracts"
import {
  applyToGraph,
  cloneGraph,
  deletedChannelIds,
  finiteRange,
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
    ...overrides,
    sidechainInputs: overrides.sidechainInputs ?? []
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
        sourceLengthTicks: 960,
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
            sourceLengthTicks: 3_840,
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
  it("validates aux side-chain buses and rejects feedback candidates", () => {
    const value = graph()
    value.channels.push({
      ...structuredClone(value.channels[0]!),
      id: "aux-1",
      kind: "aux",
      name: "Aux 1",
      inputSource: "bus",
      inputFormat: "stereo",
      inputChannels: [1, 2]
    })
    const sidechainDescriptor: PluginDescriptor = {
      ...effectDescriptor,
      buses: [
        {
          index: 0,
          direction: "input",
          kind: "main",
          name: "Main In",
          channels: 2,
          defaultActive: true
        },
        {
          index: 1,
          direction: "input",
          kind: "aux",
          name: "Side-chain",
          channels: 2,
          defaultActive: false
        },
        {
          index: 0,
          direction: "output",
          kind: "main",
          name: "Main Out",
          channels: 2,
          defaultActive: true
        }
      ]
    }
    value.plugins.push(
      plugin({
        descriptor: sidechainDescriptor,
        sidechainInputs: [{ inputBusIndex: 1, sourceChannelId: "aux-1" }]
      })
    )
    expect(() => validateGraph(value)).not.toThrow()

    value.sends.push({
      id: "feedback",
      sourceChannelId: "instrument-1",
      targetChannelId: null,
      targetBus: 1,
      sortOrder: 0,
      enabled: true,
      tap: "post-pan",
      levelDb: 0
    })
    expect(() => validateGraph(value)).toThrow("feedback loop")

    value.sends = []
    value.plugins[0]!.sidechainInputs = [{ inputBusIndex: 1, sourceChannelId: "instrument-1" }]
    expect(() => validateGraph(value)).toThrow("own channel")
  })

  it("clears a deleted source and restores the route through the delete inverse", () => {
    const before = graph()
    const sourceChannel = {
      ...structuredClone(before.channels[0]!),
      id: "audio-1",
      kind: "audio" as const,
      name: "Audio 1",
      sortOrder: 1,
      inputSource: "hardware" as const,
      inputFormat: "stereo" as const,
      inputChannels: [1, 2]
    }
    before.channels.push(sourceChannel)
    before.tracks.push({ id: "track:audio-1", channelId: sourceChannel.id, sortOrder: 1 })
    before.plugins.push(
      plugin({
        descriptor: {
          ...effectDescriptor,
          buses: [
            {
              index: 1,
              direction: "input",
              kind: "aux",
              name: "Side-chain",
              channels: 1,
              defaultActive: false
            }
          ]
        },
        sidechainInputs: [{ inputBusIndex: 1, sourceChannelId: sourceChannel.id }]
      })
    )
    const command: ProjectCommand = { type: "delete-track", trackId: "track:audio-1" }
    const inverse = inverseFor(before, command)
    const deleted = applyToGraph(before, command)

    expect(deleted.plugins[0]?.sidechainInputs).toEqual([])
    expect(applyToGraph(deleted, inverse)).toEqual(before)
  })

  it("updates project and track Markdown notes invertibly", () => {
    const before = graph()
    before.projectNotes = "Initial project note"
    before.tracks[0]!.notes = "Initial track note"
    const command: ProjectCommand = {
      type: "batch",
      commands: [
        { type: "update-project-notes", notes: "# Mix pass" },
        {
          type: "update-track",
          trackId: "track:instrument-1",
          patch: { notes: "Try a **shorter** release." }
        }
      ]
    }

    const after = applyToGraph(before, command)

    expect(after.projectNotes).toBe("# Mix pass")
    expect(after.tracks[0]?.notes).toBe("Try a **shorter** release.")
    expect(applyToGraph(after, inverseFor(before, command))).toEqual(before)
  })

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
      sourceLengthFrames: 24_000,
      fadeInFrames: 0,
      fadeOutFrames: 0,
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
      sourceLengthFrames: 480,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      assetSampleRate: 48_000,
      assetChannels: 2
    }
    const created = applyToGraph(before, { type: "create-audio-clip", clip })
    const editCommand: ProjectCommand = {
      type: "update-audio-clip",
      clipId: clip.id,
      patch: {
        startFrame: 120,
        sourceOffsetFrames: 120,
        lengthFrames: 360,
        fadeInFrames: 60,
        fadeOutFrames: 60
      }
    }
    const edited = applyToGraph(created, editCommand)
    expect(edited.audioClips[0]).toMatchObject(editCommand.patch)
    expect(applyToGraph(edited, inverseFor(created, editCommand))).toEqual(created)

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
          { type: "update-send", sendId: "send", patch: { levelDb: -6 } },
          { type: "update-project-notes", notes: "Project note" },
          { type: "update-track", trackId: "track:instrument-1", patch: { notes: "Track note" } }
        ]
      })
    ).toBe(true)
    expect(
      onlyRealtimeParameters({
        type: "update-track",
        trackId: "track:instrument-1",
        patch: { sortOrder: 2 }
      })
    ).toBe(false)
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

describe("project graph validation and command guards", () => {
  it("rejects non-text project and track notes", () => {
    expect(() => validateGraph({ ...graph(), projectNotes: 42 as unknown as string })).toThrowError(
      "Project notes must be text"
    )

    const invalidTrackNotes = graph()
    invalidTrackNotes.tracks[0]!.notes = 42 as unknown as string
    expect(() => validateGraph(invalidTrackNotes)).toThrowError("Track notes must be text")
  })

  it("validates finite ranges and rejects unknown lookup targets", () => {
    expect(() => finiteRange(0.5, 0, 1, "Sample")).not.toThrow()
    expect(() => finiteRange(Number.NaN, 0, 1, "Sample")).toThrow("Sample must be between")
    expect(() => finiteRange(2, 0, 1, "Sample")).toThrow("Sample must be between")

    const value = graph()
    expect(() =>
      applyToGraph(value, { type: "update-track", trackId: "missing", patch: { sortOrder: 1 } })
    ).toThrow("Project track 'missing' was not found")
    expect(() =>
      applyToGraph(value, { type: "update-channel", channelId: "missing", patch: { gainDb: 0 } })
    ).toThrow("Mixer channel 'missing' was not found")
    expect(() =>
      applyToGraph(value, { type: "update-send", sendId: "missing", patch: { levelDb: 0 } })
    ).toThrow("Mixer send 'missing' was not found")
    expect(() =>
      applyToGraph(value, {
        type: "move-audio-clip",
        clipId: "missing",
        trackId: "track:instrument-1",
        startFrame: 0
      })
    ).toThrow("Timeline clip 'missing' was not found")
    expect(() =>
      applyToGraph(value, {
        type: "update-plugin",
        pluginId: "missing",
        patch: { enabled: false }
      })
    ).toThrow("Plugin instance 'missing' was not found")
    expect(() =>
      applyToGraph(value, {
        type: "move-midi-clip",
        clipId: "missing",
        trackId: "track:instrument-1",
        startTick: 0
      })
    ).toThrow("MIDI clip 'missing' was not found")
    expect(() =>
      applyToGraph(value, {
        type: "update-midi-notes",
        clipId: "clip-1",
        updates: [{ noteId: "missing", patch: { key: 1 } }]
      })
    ).toThrow("MIDI note 'missing' was not found")
    expect(() => inverseFor(value, { type: "delete-send", sendId: "missing" })).toThrow(
      "Mixer send 'missing' was not found"
    )
    expect(cloneGraph(value)).toEqual(value)
    expect(cloneGraph(value)).not.toBe(value)
  })

  it("rejects deleting master, system, track-owned, and still-routed output channels", () => {
    const value = graph()
    expect(() => applyToGraph(value, { type: "delete-channel", channelId: "master" })).toThrow(
      "Master cannot be deleted"
    )
    expect(() =>
      applyToGraph(value, { type: "delete-channel", channelId: "instrument-1" })
    ).toThrow("Track-owned channels must be deleted through delete-track")

    const withSystem = graph()
    withSystem.channels.push({
      ...structuredClone(withSystem.channels[0]!),
      id: "metronome",
      systemRole: "metronome",
      name: "Metronome",
      midiInput: undefined
    })
    expect(() =>
      applyToGraph(withSystem, { type: "delete-channel", channelId: "metronome" })
    ).toThrow("System channels cannot be deleted")
    expect(() =>
      inverseFor(withSystem, { type: "delete-channel", channelId: "metronome" })
    ).toThrow("System channels cannot be deleted")

    expect(() => applyToGraph(value, { type: "delete-channel", channelId: "output" })).toThrow(
      "An Output must be unused before it can be deleted"
    )
    expect(() => inverseFor(value, { type: "delete-channel", channelId: "instrument-1" })).toThrow(
      "Track-owned channels must be deleted through delete-track"
    )
    expect(() => inverseFor(value, { type: "delete-channel", channelId: "master" })).toThrow(
      "Master cannot be deleted"
    )
  })

  it("rejects moving an instrument into an occupied slot and replacing a missing plugin", () => {
    const instrumentDescriptor: PluginDescriptor = {
      ...effectDescriptor,
      classId: "instrument-class",
      kind: "instrument",
      name: "Synth",
      supportedAudioModes: ["stereo"]
    }
    const before = graph()
    const withInstrument = applyToGraph(before, {
      type: "create-plugin",
      plugin: plugin({
        id: "inst-1",
        role: "instrument",
        slotOrder: 0,
        classId: instrumentDescriptor.classId,
        descriptor: instrumentDescriptor,
        audioMode: "stereo"
      })
    })
    const second = applyToGraph(withInstrument, {
      type: "create-plugin",
      plugin: plugin({
        id: "inst-2",
        channelId: "master",
        role: "instrument",
        slotOrder: 0,
        classId: instrumentDescriptor.classId,
        descriptor: instrumentDescriptor,
        audioMode: "stereo"
      })
    })
    expect(() =>
      applyToGraph(second, {
        type: "move-plugin",
        pluginId: "inst-2",
        channelId: "instrument-1",
        role: "instrument",
        slotOrder: 0
      })
    ).toThrow("Replace the assigned instrument instead of moving into an occupied slot")

    expect(() =>
      applyToGraph(before, {
        type: "replace-plugin",
        pluginId: "missing",
        plugin: plugin()
      })
    ).toThrow("Plugin instance 'missing' was not found")
  })

  it("moves insert plugins across channels and reindexes source slots", () => {
    const before = graph()
    before.tracks.push({ id: "track:instrument-2", channelId: "instrument-2", sortOrder: 1 })
    before.channels.push({
      ...structuredClone(before.channels[0]!),
      id: "instrument-2",
      name: "Instrument 2",
      sortOrder: 1
    })
    const withPlugins = applyToGraph(
      applyToGraph(before, {
        type: "create-plugin",
        plugin: plugin({ id: "fx-a", slotOrder: 0 })
      }),
      {
        type: "create-plugin",
        plugin: plugin({ id: "fx-b", slotOrder: 1 })
      }
    )
    const moved = applyToGraph(withPlugins, {
      type: "move-plugin",
      pluginId: "fx-a",
      channelId: "instrument-2",
      role: "insert",
      slotOrder: 0
    })
    expect(moved.plugins.find((candidate) => candidate.id === "fx-a")).toMatchObject({
      channelId: "instrument-2",
      slotOrder: 0
    })
    expect(moved.plugins.find((candidate) => candidate.id === "fx-b")?.slotOrder).toBe(0)
    expect(
      applyToGraph(
        moved,
        inverseFor(withPlugins, {
          type: "move-plugin",
          pluginId: "fx-a",
          channelId: "instrument-2",
          role: "insert",
          slotOrder: 0
        })
      )
    ).toEqual(withPlugins)
  })

  it("deletes unused output channels with fallback rewiring and invertible restore", () => {
    const before = graph()
    const spareOutput = {
      ...structuredClone(before.channels.find((channel) => channel.id === "output")!),
      id: "output-2",
      name: "Output 2",
      hardwareOutputChannels: [3, 4] as [number, number],
      sortOrder: 1
    }
    const withSpare = applyToGraph(before, { type: "create-channel", channel: spareOutput })
    const deleted = applyToGraph(withSpare, { type: "delete-channel", channelId: "output-2" })
    expect(deleted.channels.some((channel) => channel.id === "output-2")).toBe(false)
    expect(
      applyToGraph(
        deleted,
        inverseFor(withSpare, { type: "delete-channel", channelId: "output-2" })
      )
    ).toEqual(withSpare)
  })

  it("covers delete-track inverse restoration of dependent graph entities", () => {
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
    before.audioClips.push({
      id: "audio-clip-1",
      assetId: "asset-1",
      trackId: "track:audio-1",
      name: "Take",
      startFrame: 0,
      sourceOffsetFrames: 0,
      lengthFrames: 480,
      sourceLengthFrames: 480,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      assetSampleRate: 48_000,
      assetChannels: 2
    })
    before.sends.push({
      id: "send-1",
      sourceChannelId: "audio-1",
      targetChannelId: "output",
      targetBus: null,
      sortOrder: 0,
      enabled: true,
      tap: "post",
      levelDb: -6
    })
    before.plugins.push(plugin({ id: "fx-1", channelId: "audio-1" }))
    const deleteTrack: ProjectCommand = { type: "delete-track", trackId: "track:audio-1" }
    const deleted = applyToGraph(before, deleteTrack)
    expect(deleted.tracks.some((track) => track.id === "track:audio-1")).toBe(false)
    const restored = applyToGraph(deleted, inverseFor(before, deleteTrack))
    expect(restored.audioClips).toEqual(before.audioClips)
    expect(restored.sends).toEqual(before.sends)
    expect(restored.plugins).toEqual(before.plugins)
  })

  it("validates track, channel, send, plugin, tempo, and routing constraints", () => {
    const duplicateTrack = graph()
    duplicateTrack.tracks.push({ ...duplicateTrack.tracks[0]! })
    expect(() => validateGraph(duplicateTrack)).toThrow("Project track IDs must be unique")

    const longTrack = graph()
    longTrack.tracks[0]!.id = "t".repeat(65)
    expect(() => validateGraph(longTrack)).toThrow("at most 64 UTF-8 bytes")

    const badOrder = graph()
    badOrder.tracks[0]!.sortOrder = -1
    expect(() => validateGraph(badOrder)).toThrow("non-negative safe integer")

    const badGain = graph()
    badGain.channels[0]!.gainDb = 100
    expect(() => validateGraph(badGain)).toThrow("Channel gain")

    const audio = graph()
    audio.tracks.push({ id: "track:audio", channelId: "audio", sortOrder: 1 })
    audio.channels.push({
      ...structuredClone(audio.channels[0]!),
      id: "audio",
      kind: "audio",
      name: "Audio",
      inputSource: "hardware",
      inputFormat: "stereo",
      inputChannels: [1],
      midiInput: undefined
    })
    expect(() => validateGraph(audio)).toThrow("input mappings must match their input format")

    const soloMaster = graph()
    soloMaster.channels.find((channel) => channel.kind === "master")!.soloed = true
    expect(() => validateGraph(soloMaster)).toThrow("Master cannot be soloed")

    const noOutput = graph()
    noOutput.channels = noOutput.channels.filter((channel) => channel.kind !== "output")
    noOutput.channels[0]!.outputChannelId = null
    noOutput.channels[0]!.outputBus = 1
    expect(() => validateGraph(noOutput)).toThrow("at least one hardware Output")

    const duplicateOutputMap = graph()
    duplicateOutputMap.channels.push({
      ...structuredClone(duplicateOutputMap.channels.find((channel) => channel.id === "output")!),
      id: "output-2",
      hardwareOutputChannels: [1, 2],
      sortOrder: 1
    })
    expect(() => validateGraph(duplicateOutputMap)).toThrow(
      "Hardware Output channel pairs must be unique"
    )

    const badSend = graph()
    badSend.sends.push({
      id: "send-1",
      sourceChannelId: "master",
      targetBus: 1,
      targetChannelId: null,
      sortOrder: 0,
      enabled: true,
      tap: "post",
      levelDb: 0
    })
    expect(() => validateGraph(badSend)).toThrow(
      "Only Audio, Instrument, and Aux channels can source sends"
    )

    const badPlugin = graph()
    badPlugin.plugins.push(
      plugin({
        role: "instrument",
        descriptor: { ...effectDescriptor, kind: "effect" },
        classId: effectDescriptor.classId
      })
    )
    expect(() => validateGraph(badPlugin)).toThrow(
      "An instrument slot requires an instrument plugin on an Instrument track"
    )

    const badTempo = graph()
    ;(badTempo.tempoMap as { ticksPerQuarter: number }).ticksPerQuarter = 480
    expect(() => validateGraph(badTempo)).toThrow("960 PPQ")

    const badKey = graph()
    badKey.keySignatureEvents = [{ tick: 10, fifths: 0, mode: "major" }]
    expect(() => validateGraph(badKey)).toThrow("Key-signature maps require an event at tick 0")

    const midiOnAudio = graph()
    midiOnAudio.tracks.push({ id: "track:audio", channelId: "audio", sortOrder: 1 })
    midiOnAudio.channels.push({
      ...structuredClone(midiOnAudio.channels[0]!),
      id: "audio",
      kind: "audio",
      name: "Audio",
      inputSource: "hardware",
      inputFormat: "stereo",
      inputChannels: [1, 2],
      midiInput: undefined
    })
    midiOnAudio.midiClips[0]!.trackId = "track:audio"
    expect(() => validateGraph(midiOnAudio)).toThrow("MIDI clips must belong to Instrument tracks")

    const feedback = graph()
    feedback.channels.push({
      ...structuredClone(feedback.channels[0]!),
      id: "aux-1",
      kind: "aux",
      name: "Aux",
      inputSource: "bus",
      inputFormat: "mono",
      inputChannels: [1],
      outputBus: 1,
      outputChannelId: null,
      midiInput: undefined
    })
    // Aux feeds BUS 1 and also consumes BUS 1.
    expect(() => validateGraph(feedback)).toThrow("feedback loop")
  })

  it("validates instrument MIDI routes and audio clip ownership", () => {
    const badMidi = graph()
    badMidi.channels[0]!.midiInput = { portId: "port", portName: null, channel: 0 }
    expect(() => validateGraph(badMidi)).toThrow(
      "Instrument MIDI routes require a valid port and channel"
    )

    const armedMaster = graph()
    armedMaster.channels.find((channel) => channel.kind === "master")!.recordArmed = true
    expect(() => validateGraph(armedMaster)).toThrow(
      "Only Audio and ordinary Instrument tracks can arm recording"
    )

    const value = graph()
    value.tracks.push({ id: "track:audio", channelId: "audio", sortOrder: 1 })
    value.channels.push({
      ...structuredClone(value.channels[0]!),
      id: "audio",
      kind: "audio",
      name: "Audio",
      inputSource: "hardware",
      inputFormat: "stereo",
      inputChannels: [1, 2],
      midiInput: undefined
    })
    value.audioClips.push({
      id: "clip",
      assetId: "asset",
      trackId: "track:instrument-1",
      name: "Misplaced",
      startFrame: 0,
      sourceOffsetFrames: 0,
      lengthFrames: 100,
      sourceLengthFrames: 100,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      assetSampleRate: 48_000,
      assetChannels: 2
    })
    expect(() => validateGraph(value)).toThrow("Timeline clips must belong to audio tracks")

    const badClipFrames = graph()
    badClipFrames.tracks.push({ id: "track:audio", channelId: "audio", sortOrder: 1 })
    badClipFrames.channels.push({
      ...structuredClone(badClipFrames.channels[0]!),
      id: "audio",
      kind: "audio",
      name: "Audio",
      inputSource: "hardware",
      inputFormat: "stereo",
      inputChannels: [1, 2],
      midiInput: undefined
    })
    badClipFrames.audioClips.push({
      id: "clip",
      assetId: "asset",
      trackId: "track:audio",
      name: "Bad",
      startFrame: -1,
      sourceOffsetFrames: 0,
      lengthFrames: 100,
      sourceLengthFrames: 100,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      assetSampleRate: 48_000,
      assetChannels: 2
    })
    expect(() => validateGraph(badClipFrames)).toThrow(
      "Clip start frame must be a non-negative safe integer"
    )
  })

  it("treats midi source commands as no-ops while preserving invertibility", () => {
    const before = graph()
    const source = {
      id: "source-2",
      name: "Source",
      contentHash: "hash",
      rawBytes: new Uint8Array([1])
    }
    expect(applyToGraph(before, { type: "create-midi-source", source })).toEqual(before)
    expect(inverseFor(before, { type: "create-midi-source", source })).toEqual({
      type: "delete-midi-source",
      source
    })
  })
})

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_INSTRUMENT_COLOR,
  IPC_PROTOCOL_VERSION,
  MUSICAL_TICKS_PER_QUARTER
} from "@yadaw/contracts"
import type {
  MidiImportPlan,
  MixerChannelState,
  PluginDescriptor,
  PluginInstanceState,
  ProjectCommand,
  ProjectGraphRef,
  RpcRequestMeta
} from "@yadaw/contracts"
import type { NativeMidiTrack, NativeNormalizedSmf } from "@yadaw/dsp-node"
import { MidiImportService } from "./midi-import-service"
import type { PluginCatalogService } from "./plugin-catalog-service"
import type { ProjectCommandService } from "./project-command-service"
import type { ProjectGraphService } from "./project-graph-service"

const parseMidiFile = vi.hoisted(() => vi.fn())

vi.mock("@yadaw/dsp-node", () => ({ parseMidiFile }))

let directory: string
let midiPath: string

function track(overrides: Partial<NativeMidiTrack> = {}): NativeMidiTrack {
  return {
    sourceTrack: 0,
    sequence: 0,
    name: "Piano",
    lengthTicks: 1_920,
    notes: [
      { startTick: 0, durationTicks: 480, channel: 0, key: 60, velocity: 100, releaseVelocity: 64 }
    ],
    events: [{ tick: 0, channel: 0, kind: "control-change", data: Buffer.from([0xb0, 7, 100]) }],
    tempoEvents: [{ tick: 0, beatsPerMinute: 100 }],
    timeSignatureEvents: [{ tick: 0, numerator: 3, denominator: 4 }],
    warnings: [],
    ...overrides
  }
}

function parsed(overrides: Partial<NativeNormalizedSmf> = {}): NativeNormalizedSmf {
  return {
    format: 1,
    sourceTiming: "ppq-480",
    tracks: [track()],
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }],
    warnings: ["Dropped a proprietary meta event"],
    ...overrides
  }
}

function channel(overrides: Partial<MixerChannelState> = {}): MixerChannelState {
  return {
    id: "channel-1",
    kind: "instrument",
    systemRole: null,
    name: "Instrument 1",
    color: DEFAULT_INSTRUMENT_COLOR,
    sortOrder: 0,
    inputSource: null,
    inputFormat: null,
    midiInput: { portId: null, portName: null, channel: null },
    gainDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
    outputChannelId: "output-1",
    outputBus: null,
    recordArmed: false,
    inputMonitoring: true,
    inputChannels: [],
    hardwareOutputChannels: [],
    ...overrides
  }
}

function descriptor(overrides: Partial<PluginDescriptor> = {}): PluginDescriptor {
  return {
    source: { kind: "builtin", id: "yadaw-sine" },
    classId: "sine-class",
    modulePath: "/plugins/Sine.vst3",
    name: "Sine",
    vendor: "Yadaw",
    version: "1.0.0",
    categories: ["Instrument", "Synth"],
    kind: "instrument",
    supportedAudioModes: ["stereo"],
    architecture: "x86_64",
    buses: [],
    hasEditor: false,
    compatibility: "compatible",
    compatibilityReason: null,
    ...overrides
  }
}

interface Harness {
  service: MidiImportService
  mixer: {
    snapshot: ReturnType<typeof vi.fn>
    executeMidiImport: ReturnType<typeof vi.fn>
  }
  plugins: { list: ReturnType<typeof vi.fn> }
}

function createService(
  options: {
    channels?: MixerChannelState[]
    plugins?: PluginInstanceState[]
    descriptors?: PluginDescriptor[]
  } = {}
): Harness {
  const mixer = {
    snapshot: vi.fn(async () => {
      const channels = options.channels ?? [
        channel({ id: "output-1", kind: "output", name: "Output 1–2" })
      ]
      return {
        sampleRate: 48_000,
        tracks: channels
          .filter(
            (candidate) =>
              candidate.systemRole === null &&
              (candidate.kind === "audio" || candidate.kind === "instrument")
          )
          .map((candidate) => ({
            id: `track:${candidate.id}`,
            channelId: candidate.id,
            sortOrder: candidate.sortOrder
          })),
        channels,
        plugins: options.plugins ?? [],
        tempoMap: {
          ticksPerQuarter: MUSICAL_TICKS_PER_QUARTER,
          tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
          timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
        }
      }
    }),
    executeMidiImport: vi.fn(async () => ({ ok: true }))
  }
  const plugins = { list: vi.fn(() => ({ plugins: options.descriptors ?? [descriptor()] })) }

  return {
    mixer,
    plugins,
    service: new MidiImportService(
      mixer as unknown as ProjectGraphService,
      mixer as unknown as ProjectCommandService,
      plugins as unknown as PluginCatalogService
    )
  }
}

function plan(overrides: Partial<MidiImportPlan> & { token: string }): MidiImportPlan {
  return {
    importTempoMap: false,
    insertionTick: 0,
    tracks: [{ sourceTrack: 0, sequence: 0, target: { type: "new" } }],
    ...overrides
  }
}

const projectGraph: ProjectGraphRef = {
  kind: "project-graph",
  id: "project:graph",
  epoch: "test-main",
  generation: 1
}

function prepare(service: MidiImportService, path: string) {
  return service.prepare(path, projectGraph)
}

function meta(target: ProjectGraphRef = projectGraph): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: `midi-import-request:${crypto.randomUUID()}`,
    target,
    expectedRevision: 1,
    mutation: {
      operationId: `midi-import-operation:${crypto.randomUUID()}`,
      idempotencyKey: `midi-import-idempotency:${crypto.randomUUID()}`
    }
  }
}

function commit(service: MidiImportService, value: MidiImportPlan) {
  const request = meta()
  return service.commit(request, value)
}

function commandsFrom(mixer: Harness["mixer"]): ProjectCommand[] {
  const [, , batch] = mixer.executeMidiImport.mock.calls[0] as [
    unknown,
    unknown,
    { commands: ProjectCommand[] }
  ]
  return batch.commands
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "yadaw-midi-"))
  midiPath = join(directory, "song.mid")
  await writeFile(midiPath, Buffer.from("MThd-fixture"))
  parseMidiFile.mockReset()
  parseMidiFile.mockResolvedValue(parsed())
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("prepare", () => {
  it("summarizes the file against the project tempo map", async () => {
    const { service, mixer } = createService()

    const preview = await prepare(service, midiPath)

    expect(parseMidiFile).toHaveBeenCalledWith(midiPath, {
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    })
    expect(mixer.snapshot).toHaveBeenCalledTimes(1)
    expect(preview).toMatchObject({
      path: midiPath,
      format: 1,
      sourceTiming: "ppq-480",
      warnings: ["Dropped a proprietary meta event"]
    })
    expect(preview.token).toBeTruthy()
  })

  it("reports per-track note and event counts", async () => {
    const { service } = createService()

    const [preview] = (await prepare(service, midiPath)).tracks

    expect(preview).toMatchObject({
      sourceTrack: 0,
      sequence: 0,
      name: "Piano",
      noteCount: 1,
      eventCount: 1,
      lengthTicks: 1_920
    })
  })

  it("names unnamed tracks after their one-based source index", async () => {
    parseMidiFile.mockResolvedValue(parsed({ tracks: [track({ name: "", sourceTrack: 2 })] }))
    const { service } = createService()

    const preview = await prepare(service, midiPath)

    expect(preview.tracks[0]?.name).toBe("MIDI Track 3")
  })

  it("normalizes the file and per-track tempo maps to the project resolution", async () => {
    const { service } = createService()

    const preview = await prepare(service, midiPath)

    expect(preview.tempoMap).toEqual({
      ticksPerQuarter: MUSICAL_TICKS_PER_QUARTER,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    })
    expect(preview.tracks[0]?.tempoMap).toEqual({
      ticksPerQuarter: MUSICAL_TICKS_PER_QUARTER,
      tempoEvents: [{ tick: 0, beatsPerMinute: 100 }],
      timeSignatureEvents: [{ tick: 0, numerator: 3, denominator: 4 }]
    })
  })

  it("rejects a file whose format the importer does not understand", async () => {
    parseMidiFile.mockResolvedValue(parsed({ format: 3 }))
    const { service } = createService()

    await expect(prepare(service, midiPath)).rejects.toThrow(
      "Unsupported Standard MIDI File format"
    )
  })

  it("keeps only the most recent preview", async () => {
    const { service } = createService()
    const first = await prepare(service, midiPath)
    const second = await prepare(service, midiPath)

    await expect(commit(service, plan({ token: first.token }))).rejects.toThrow(
      "MIDI import preview has expired"
    )
    await expect(commit(service, plan({ token: second.token }))).resolves.toBeTruthy()
  })
})

describe("commit validation", () => {
  it("rejects an unknown or already-used token", async () => {
    const { service } = createService()
    const preview = await prepare(service, midiPath)

    await expect(commit(service, plan({ token: "not-a-token" }))).rejects.toThrow(
      "MIDI import preview has expired; choose the file again"
    )

    await commit(service, plan({ token: preview.token }))
    await expect(commit(service, plan({ token: preview.token }))).rejects.toThrow(
      "MIDI import preview has expired; choose the file again"
    )
  })

  it("rejects a preview prepared for an older project graph generation", async () => {
    const { service } = createService()
    const preview = await prepare(service, midiPath)
    const nextGraph: ProjectGraphRef = { ...projectGraph, generation: 2 }

    await expect(service.commit(meta(nextGraph), plan({ token: preview.token }))).rejects.toThrow(
      "MIDI import preview belongs to a stale project graph"
    )
  })

  it("rejects a negative or non-integer insertion tick", async () => {
    const { service } = createService()
    const { token } = await prepare(service, midiPath)

    await expect(commit(service, plan({ token, insertionTick: -1 }))).rejects.toThrow(TypeError)
    await expect(commit(service, plan({ token, insertionTick: 1.5 }))).rejects.toThrow(
      "MIDI insertion tick must be a non-negative integer"
    )
  })

  it("requires at least one track that is not ignored", async () => {
    const { service } = createService()
    const { token } = await prepare(service, midiPath)

    await expect(
      commit(
        service,
        plan({ token, tracks: [{ sourceTrack: 0, sequence: 0, target: { type: "ignore" } }] })
      )
    ).rejects.toThrow("Select at least one MIDI track to import")
  })

  it("imports a single Format 2 sequence at a time", async () => {
    parseMidiFile.mockResolvedValue(
      parsed({
        format: 2,
        tracks: [track({ sequence: 0 }), track({ sourceTrack: 1, sequence: 1 })]
      })
    )
    const { service } = createService()
    const { token } = await prepare(service, midiPath)

    await expect(
      commit(
        service,
        plan({
          token,
          tracks: [
            { sourceTrack: 0, sequence: 0, target: { type: "new" } },
            { sourceTrack: 1, sequence: 1, target: { type: "new" } }
          ]
        })
      )
    ).rejects.toThrow("Import one Format 2 sequence at a time")
  })

  it("requires the project to have a hardware output", async () => {
    const { service } = createService({ channels: [] })
    const { token } = await prepare(service, midiPath)

    await expect(commit(service, plan({ token }))).rejects.toThrow("Project has no hardware Output")
  })

  it("rejects a plan that references a track the file does not contain", async () => {
    const { service } = createService()
    const { token } = await prepare(service, midiPath)

    await expect(
      commit(
        service,
        plan({ token, tracks: [{ sourceTrack: 9, sequence: 0, target: { type: "new" } }] })
      )
    ).rejects.toThrow("MIDI source track 9 was not found")
  })
})

describe("commit", () => {
  it("creates an instrument track routed to the hardware output", async () => {
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(service, plan({ token }))

    const created = commandsFrom(mixer).find((command) => command.type === "create-track")
    expect(created).toMatchObject({
      channel: {
        kind: "instrument",
        systemRole: null,
        name: "Piano",
        color: DEFAULT_INSTRUMENT_COLOR,
        outputChannelId: "output-1",
        sortOrder: 0
      }
    })
  })

  it("prefers an explicit track name over the one in the file", async () => {
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        tracks: [{ sourceTrack: 0, sequence: 0, target: { type: "new", name: "  Lead  " } }]
      })
    )

    expect(commandsFrom(mixer).find((command) => command.type === "create-track")).toMatchObject({
      channel: { name: "Lead" }
    })
  })

  it("continues the existing instrument numbering", async () => {
    const { service, mixer } = createService({
      channels: [
        channel({ id: "output-1", kind: "output" }),
        channel({ id: "instrument-1", name: "Bass" }),
        channel({ id: "metronome", kind: "instrument", systemRole: "metronome" })
      ]
    })
    parseMidiFile.mockResolvedValue(parsed({ tracks: [track({ name: "" })] }))
    const { token } = await prepare(service, midiPath)

    await commit(service, plan({ token }))

    expect(commandsFrom(mixer).find((command) => command.type === "create-track")).toMatchObject({
      channel: { name: "Instrument 2", sortOrder: 1 }
    })
  })

  it("converts notes and events into a clip on the new track", async () => {
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(service, plan({ token }))

    const commands = commandsFrom(mixer)
    const created = commands.find((command) => command.type === "create-track")
    const clip = commands.find((command) => command.type === "create-midi-clip")
    expect(clip).toMatchObject({
      clip: {
        trackId: created?.type === "create-track" ? created.track.id : undefined,
        name: "Piano",
        startTick: 0,
        lengthTicks: 1_920,
        sourceOffsetTicks: 0
      }
    })
    if (clip?.type !== "create-midi-clip") throw new Error("expected a clip command")
    expect(clip.clip.notes).toHaveLength(1)
    expect(clip.clip.notes[0]).toMatchObject({ startTick: 0, key: 60, velocity: 100 })
    expect(clip.clip.events[0]).toMatchObject({ tick: 0, channel: 0, kind: "control-change" })
    expect([...(clip.clip.events[0]?.data ?? [])]).toEqual([0xb0, 7, 100])
  })

  it("gives every clip a length of at least one tick", async () => {
    parseMidiFile.mockResolvedValue(parsed({ tracks: [track({ lengthTicks: 0 })] }))
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(service, plan({ token }))

    const clip = commandsFrom(mixer).find((command) => command.type === "create-midi-clip")
    expect(clip?.type === "create-midi-clip" && clip.clip.lengthTicks).toBe(1)
  })

  it("places the clip at the insertion tick when the tempo map is not imported", async () => {
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(service, plan({ token, insertionTick: 3_840 }))

    const clip = commandsFrom(mixer).find((command) => command.type === "create-midi-clip")
    expect(clip?.type === "create-midi-clip" && clip.clip.startTick).toBe(3_840)
  })

  it("anchors the clip at zero and replaces the tempo map when asked", async () => {
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(service, plan({ token, importTempoMap: true, insertionTick: 3_840 }))

    const commands = commandsFrom(mixer)
    expect(commands[0]).toMatchObject({
      type: "replace-tempo-map",
      tempoMap: { tempoEvents: [{ tick: 0, beatsPerMinute: 120 }] }
    })
    const clip = commands.find((command) => command.type === "create-midi-clip")
    expect(clip?.type === "create-midi-clip" && clip.clip.startTick).toBe(0)
  })

  it("uses the selected sequence's tempo map for a Format 2 file", async () => {
    parseMidiFile.mockResolvedValue(
      parsed({
        format: 2,
        tracks: [
          track({ sequence: 0 }),
          track({
            sourceTrack: 1,
            sequence: 1,
            tempoEvents: [{ tick: 0, beatsPerMinute: 90 }]
          })
        ]
      })
    )
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        importTempoMap: true,
        tracks: [{ sourceTrack: 1, sequence: 1, target: { type: "new" } }]
      })
    )

    expect(commandsFrom(mixer)[0]).toMatchObject({
      type: "replace-tempo-map",
      tempoMap: { tempoEvents: [{ tick: 0, beatsPerMinute: 90 }] }
    })
  })

  it("targets an existing instrument track without creating a channel", async () => {
    const { service, mixer } = createService({
      channels: [channel({ id: "output-1", kind: "output" }), channel({ id: "instrument-1" })]
    })
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        tracks: [
          {
            sourceTrack: 0,
            sequence: 0,
            target: { type: "existing", trackId: "track:instrument-1" }
          }
        ]
      })
    )

    const commands = commandsFrom(mixer)
    expect(commands.some((command) => command.type === "create-track")).toBe(false)
    const clip = commands.find((command) => command.type === "create-midi-clip")
    expect(clip?.type === "create-midi-clip" && clip.clip.trackId).toBe("track:instrument-1")
  })

  it("refuses to target an audio track, a system track, or a missing track", async () => {
    const channels = [
      channel({ id: "output-1", kind: "output" }),
      channel({ id: "audio-1", kind: "audio" }),
      channel({ id: "metronome", kind: "instrument", systemRole: "metronome" })
    ]

    for (const trackId of ["track:audio-1", "track:metronome", "track:nope"]) {
      const { service } = createService({ channels })
      const { token } = await prepare(service, midiPath)

      await expect(
        commit(
          service,
          plan({
            token,
            tracks: [{ sourceTrack: 0, sequence: 0, target: { type: "existing", trackId } }]
          })
        ),
        trackId
      ).rejects.toThrow("MIDI clips can only be imported to Instrument tracks")
    }
  })

  it("adds the requested instrument plug-in to a new track", async () => {
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        tracks: [
          { sourceTrack: 0, sequence: 0, target: { type: "new", instrumentClassId: "sine-class" } }
        ]
      })
    )

    const created = commandsFrom(mixer).find((command) => command.type === "create-plugin")
    expect(created).toMatchObject({
      plugin: { role: "instrument", slotOrder: 0, classId: "sine-class", audioMode: "stereo" }
    })
  })

  it("falls back to mono for an instrument without a stereo mode", async () => {
    const { service, mixer } = createService({
      descriptors: [descriptor({ supportedAudioModes: ["mono"] })]
    })
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        tracks: [
          { sourceTrack: 0, sequence: 0, target: { type: "new", instrumentClassId: "sine-class" } }
        ]
      })
    )

    const created = commandsFrom(mixer).find((command) => command.type === "create-plugin")
    expect(created?.type === "create-plugin" && created.plugin.audioMode).toBe("mono")
  })

  it("replaces the instrument already loaded on an existing track", async () => {
    const { service, mixer } = createService({
      channels: [channel({ id: "output-1", kind: "output" }), channel({ id: "instrument-1" })],
      plugins: [
        {
          id: "plugin-1",
          channelId: "instrument-1",
          role: "instrument",
          slotOrder: 0,
          classId: "old-class",
          descriptor: descriptor({ classId: "old-class" }),
          audioMode: "stereo",
          enabled: true,
          sidechainInputs: [],
          componentState: new Uint8Array(),
          controllerState: new Uint8Array()
        }
      ]
    })
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        tracks: [
          {
            sourceTrack: 0,
            sequence: 0,
            target: {
              type: "existing",
              trackId: "track:instrument-1",
              instrumentClassId: "sine-class"
            }
          }
        ]
      })
    )

    expect(commandsFrom(mixer).find((command) => command.type === "replace-plugin")).toMatchObject({
      pluginId: "plugin-1",
      plugin: { id: "plugin-1", classId: "sine-class" }
    })
  })

  it("refuses an instrument that is unknown, an effect, or incompatible", async () => {
    const cases: PluginDescriptor[][] = [
      [],
      [descriptor({ kind: "effect" })],
      [descriptor({ compatibility: "quarantined" })]
    ]

    for (const descriptors of cases) {
      const { service } = createService({ descriptors })
      const { token } = await prepare(service, midiPath)

      await expect(
        commit(
          service,
          plan({
            token,
            tracks: [
              {
                sourceTrack: 0,
                sequence: 0,
                target: { type: "new", instrumentClassId: "sine-class" }
              }
            ]
          })
        )
      ).rejects.toThrow("Selected VST3 instrument is not available or compatible")
    }
  })

  it("records the source file with a content hash so the project can re-export it", async () => {
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(service, plan({ token }))

    const [, source] = mixer.executeMidiImport.mock.calls[0] as [
      unknown,
      { id: string; name: string; contentHash: string; rawBytes: Uint8Array }
    ]
    expect(source.name).toBe("song.mid")
    expect(source.contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(Buffer.from(source.rawBytes).toString()).toBe("MThd-fixture")
  })

  it("shares one source id across every clip in the import", async () => {
    parseMidiFile.mockResolvedValue(
      parsed({ tracks: [track(), track({ sourceTrack: 1, name: "Bass" })] })
    )
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        tracks: [
          { sourceTrack: 0, sequence: 0, target: { type: "new" } },
          { sourceTrack: 1, sequence: 0, target: { type: "new" } }
        ]
      })
    )

    const clips = commandsFrom(mixer).filter((command) => command.type === "create-midi-clip")
    const [, source] = mixer.executeMidiImport.mock.calls[0] as [unknown, { id: string }]
    expect(clips).toHaveLength(2)
    expect(new Set(clips.map((clip) => clip.clip.sourceId))).toEqual(new Set([source.id]))
    expect(new Set(clips.map((clip) => clip.clip.id)).size).toBe(2)
  })

  it("skips ignored tracks while importing the rest", async () => {
    parseMidiFile.mockResolvedValue(
      parsed({ tracks: [track(), track({ sourceTrack: 1, name: "Bass" })] })
    )
    const { service, mixer } = createService()
    const { token } = await prepare(service, midiPath)

    await commit(
      service,
      plan({
        token,
        tracks: [
          { sourceTrack: 0, sequence: 0, target: { type: "ignore" } },
          { sourceTrack: 1, sequence: 0, target: { type: "new" } }
        ]
      })
    )

    const clips = commandsFrom(mixer).filter((command) => command.type === "create-midi-clip")
    expect(clips.map((clip) => clip.clip.name)).toEqual(["Bass"])
  })
})

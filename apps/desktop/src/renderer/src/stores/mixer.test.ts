import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type {
  ProjectGraphSnapshot,
  ProjectCommand,
  PluginInstanceState,
  ProjectSession,
  ProjectWorkspaceSnapshot,
  RpcResult
} from "@yadaw/contracts"
import { useProjectStore } from "./project"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useMixerStore } from "./mixer"
import { useProjectHistoryStore } from "./projectHistory"
import { applyToGraph, inverseFor } from "@yadaw/project-model"
import { planAudioClipSplit, planMidiClipSplits } from "../utils/clipEditing"

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [{ id: "track:audio", channelId: "audio", sortOrder: 0 }],
    channels: [
      {
        id: "audio",
        kind: "audio",
        systemRole: null,
        name: "Audio",
        color: "#8C83FF",
        sortOrder: 0,
        inputSource: "hardware",
        inputFormat: "stereo",
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      },
      {
        id: "aux-a",
        kind: "aux",
        systemRole: null,
        name: "Aux A",
        color: "#E8B85F",
        sortOrder: 0,
        inputSource: "bus",
        inputFormat: "mono",
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [1],
        hardwareOutputChannels: []
      },
      {
        id: "metronome",
        kind: "instrument",
        systemRole: "metronome",
        name: "Metronome",
        color: "#AD8CFF",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: true,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "aux-b",
        kind: "aux",
        systemRole: null,
        name: "Aux B",
        color: "#E8B85F",
        sortOrder: 1,
        inputSource: "bus",
        inputFormat: "mono",
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [2],
        hardwareOutputChannels: []
      },
      {
        id: "master",
        kind: "master",
        systemRole: null,
        name: "Master",
        color: "#67D9E7",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        systemRole: null,
        name: "Output 1–2",
        color: "#73D6A2",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ],
    audioClips: [],
    sends: [
      {
        id: "aux-a-to-bus-2",
        sourceChannelId: "aux-a",
        targetBus: 2,
        sortOrder: 0,
        enabled: true,
        tap: "post-pan",
        levelDb: -12
      }
    ],
    plugins: [],
    midiClips: [],
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
  }
}

const session: ProjectSession = {
  id: "project",
  path: "project.yadaw",
  configuration: {
    name: "Mixer test",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

function workspace(value: ProjectGraphSnapshot): ProjectWorkspaceSnapshot {
  return {
    project: {
      kind: "project-session",
      id: session.id,
      epoch: "test-main",
      generation: 1
    },
    projectGraph: {
      kind: "project-graph",
      id: `${session.id}:graph`,
      epoch: "test-main",
      generation: 1
    },
    revision: 1,
    session: structuredClone(session),
    graph: structuredClone(value),
    assets: []
  }
}

function success<T>(value: T, resourceRevision = 1): RpcResult<T> {
  return {
    ok: true,
    requestId: "test-request",
    operationId: "test-operation",
    resourceRevision,
    value,
    warnings: []
  }
}

function effectPlugin(): PluginInstanceState {
  return {
    id: "effect",
    channelId: "audio",
    role: "insert",
    slotOrder: 0,
    classId: "effect-class",
    descriptor: {
      source: { kind: "external" },
      classId: "effect-class",
      modulePath: "effect.vst3",
      name: "Effect",
      vendor: "YADAW",
      version: "1.0",
      categories: ["Fx"],
      kind: "effect",
      architecture: "x86_64",
      buses: [],
      supportedAudioModes: ["stereo"],
      hasEditor: true,
      compatibility: "compatible",
      compatibilityReason: null
    },
    audioMode: "stereo",
    enabled: true,
    sidechainInputs: [],
    componentState: new Uint8Array(),
    controllerState: new Uint8Array()
  }
}

describe("mixer store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().applyWorkspace(workspace(graph()))
    useAudioRuntimeStore().applyResources({
      host: {
        kind: "audio-host",
        id: "audio-host",
        epoch: "helper-epoch",
        generation: 1
      },
      engine: {
        kind: "audio-engine",
        id: "audio-engine",
        epoch: "helper-epoch",
        generation: 1
      },
      transport: null,
      midiRuntime: {
        kind: "midi-runtime",
        id: "midi-runtime",
        epoch: "helper-epoch",
        generation: 1
      },
      revision: 0
    })
  })

  it("previews plug-in bypass immediately before committing the project command", async () => {
    const initial = graph()
    initial.plugins.push(effectPlugin())
    const changed = applyToGraph(initial, {
      type: "update-plugin",
      pluginId: "effect",
      patch: { enabled: false }
    })
    window.yadaw.previewMixerParameter = vi.fn(async () => success(undefined))
    window.yadaw.executeProjectCommand = vi.fn(async () =>
      success(
        {
          graph: changed,
          inverse: {
            type: "update-plugin" as const,
            pluginId: "effect",
            patch: { enabled: true }
          }
        },
        2
      )
    )
    const mixer = useMixerStore()
    mixer.hydrate(initial)

    const committed = mixer.setPluginEnabled("effect", false)

    expect(mixer.graph.plugins[0]?.enabled).toBe(false)
    await expect(committed).resolves.toBe(true)
    expect(window.yadaw.previewMixerParameter).toHaveBeenCalledWith(expect.any(Object), {
      target: "plugin",
      id: "effect",
      parameter: "enabled",
      value: 0
    })
    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledWith(expect.any(Object), {
      type: "update-plugin",
      pluginId: "effect",
      patch: { enabled: false }
    })
  })

  it("rolls back the live bypass preview when persistence fails", async () => {
    const initial = graph()
    initial.plugins.push(effectPlugin())
    window.yadaw.previewMixerParameter = vi.fn(async () => success(undefined))
    window.yadaw.executeProjectCommand = vi.fn(async () => {
      throw new Error("database unavailable")
    })
    window.yadaw.loadProjectGraph = vi.fn(async () => success(initial, 1))
    const mixer = useMixerStore()
    mixer.hydrate(initial)

    await expect(mixer.setPluginEnabled("effect", false)).resolves.toBe(false)

    expect(mixer.graph.plugins[0]?.enabled).toBe(true)
    expect(
      vi.mocked(window.yadaw.previewMixerParameter).mock.calls.map(([, value]) => value)
    ).toEqual([
      { target: "plugin", id: "effect", parameter: "enabled", value: 0 },
      { target: "plugin", id: "effect", parameter: "enabled", value: 1 }
    ])
  })

  it("records one history entry and applies the inverse on undo", async () => {
    const initial = graph()
    const changed = structuredClone(initial)
    changed.channels[0]!.gainDb = -6
    window.yadaw.loadProjectGraph = vi.fn().mockResolvedValue(success(initial))
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockResolvedValueOnce(
        success(
          {
            graph: changed,
            inverse: { type: "update-channel", channelId: "audio", patch: { gainDb: 0 } }
          },
          2
        )
      )
      .mockResolvedValueOnce(
        success(
          {
            graph: initial,
            inverse: { type: "update-channel", channelId: "audio", patch: { gainDb: -6 } }
          },
          3
        )
      )

    const mixer = useMixerStore()
    await mixer.load()
    await mixer.updateChannel("audio", { gainDb: -6 })
    expect(mixer.graph.channels[0]?.gainDb).toBe(-6)
    expect(mixer.canUndo).toBe(true)

    await mixer.undo()
    expect(mixer.graph.channels[0]?.gainDb).toBe(0)
    expect(window.yadaw.executeProjectCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 2 }),
      {
        type: "update-channel",
        channelId: "audio",
        patch: { gainDb: 0 }
      }
    )
    expect(mixer.canRedo).toBe(true)
  })

  it("keeps input monitoring in project history through undo and redo", async () => {
    const initial = graph()
    const monitored = structuredClone(initial)
    monitored.channels[0]!.inputMonitoring = true
    window.yadaw.loadProjectGraph = vi.fn().mockResolvedValue(success(initial))
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockResolvedValueOnce(
        success(
          {
            graph: monitored,
            inverse: {
              type: "update-channel",
              channelId: "audio",
              patch: { inputMonitoring: false }
            }
          },
          2
        )
      )
      .mockResolvedValueOnce(
        success(
          {
            graph: initial,
            inverse: {
              type: "update-channel",
              channelId: "audio",
              patch: { inputMonitoring: true }
            }
          },
          3
        )
      )
      .mockResolvedValueOnce(
        success(
          {
            graph: monitored,
            inverse: {
              type: "update-channel",
              channelId: "audio",
              patch: { inputMonitoring: false }
            }
          },
          4
        )
      )

    const mixer = useMixerStore()
    await mixer.load()
    await mixer.updateChannel("audio", { inputMonitoring: true })
    expect(mixer.graph.channels[0]?.inputMonitoring).toBe(true)

    await mixer.undo()
    expect(mixer.graph.channels[0]?.inputMonitoring).toBe(false)

    await mixer.redo()
    expect(mixer.graph.channels[0]?.inputMonitoring).toBe(true)
    expect(window.yadaw.executeProjectCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ expectedRevision: 3 }),
      {
        type: "update-channel",
        channelId: "audio",
        patch: { inputMonitoring: true }
      }
    )
  })

  it("round-trips every M1 composition edit through one undo and redo entry", async () => {
    const initial = graph()
    initial.channels.push({
      ...structuredClone(initial.channels[0]!),
      id: "instrument",
      kind: "instrument",
      name: "Instrument",
      sortOrder: 1,
      inputSource: null,
      inputFormat: null,
      inputChannels: []
    })
    initial.tracks.push({ id: "track:instrument", channelId: "instrument", sortOrder: 1 })
    initial.audioClips.push({
      id: "audio-clip",
      assetId: "asset",
      trackId: "track:audio",
      name: "Audio",
      startFrame: 0,
      sourceOffsetFrames: 0,
      lengthFrames: 48_000,
      sourceLengthFrames: 96_000,
      fadeInFrames: 0,
      fadeOutFrames: 0,
      assetSampleRate: 48_000,
      assetChannels: 2
    })
    let authoritative = structuredClone(initial)
    let revision = 1
    window.yadaw.executeProjectCommand = vi.fn(async (_meta, command: ProjectCommand) => {
      const inverse = inverseFor(authoritative, command)
      authoritative = applyToGraph(authoritative, command)
      revision += 1
      return success({ graph: structuredClone(authoritative), inverse }, revision)
    })
    const mixer = useMixerStore()
    const history = useProjectHistoryStore()
    mixer.hydrate(initial)

    async function expectOneHistoryRoundTrip(command: ProjectCommand): Promise<void> {
      const before = structuredClone(mixer.graph)
      const historyLength = history.undoHistory.length
      await expect(mixer.execute(command)).resolves.toBe(true)
      const after = structuredClone(mixer.graph)
      expect(history.undoHistory).toHaveLength(historyLength + 1)

      await mixer.undo()
      expect(mixer.graph).toEqual(before)
      expect(history.undoHistory).toHaveLength(historyLength)

      await mixer.redo()
      expect(mixer.graph).toEqual(after)
      expect(history.undoHistory).toHaveLength(historyLength + 1)
    }

    await expectOneHistoryRoundTrip({
      type: "move-audio-clip",
      clipId: "audio-clip",
      trackId: "track:audio",
      startFrame: 12_000
    })
    await expectOneHistoryRoundTrip({
      type: "update-audio-clip",
      clipId: "audio-clip",
      patch: { sourceOffsetFrames: 12_000, lengthFrames: 36_000 }
    })
    await expectOneHistoryRoundTrip({
      type: "update-audio-clip",
      clipId: "audio-clip",
      patch: { fadeInFrames: 2_000, fadeOutFrames: 4_000 }
    })
    const audioSplit = planAudioClipSplit(
      mixer.graph.audioClips[0]!,
      mixer.graph.audioClips[0]!.startFrame + 18_000,
      () => "audio-right"
    )
    if (!audioSplit) throw new Error("audio split fixture must cross the playhead")
    await expectOneHistoryRoundTrip(audioSplit)
    await expectOneHistoryRoundTrip({ type: "delete-audio-clip", clipId: "audio-right" })

    await expectOneHistoryRoundTrip({
      type: "create-midi-clip",
      clip: {
        id: "midi-clip",
        sourceId: "midi-source",
        trackId: "track:instrument",
        name: "MIDI",
        startTick: 0,
        sourceOffsetTicks: 0,
        lengthTicks: 3_840,
        sourceLengthTicks: 7_680,
        notes: [
          {
            id: "note-1",
            startTick: 240,
            durationTicks: 480,
            channel: 0,
            key: 60,
            velocity: 100,
            releaseVelocity: 0
          }
        ],
        events: []
      }
    })
    await expectOneHistoryRoundTrip({
      type: "move-midi-clip",
      clipId: "midi-clip",
      trackId: "track:instrument",
      startTick: 960
    })
    await expectOneHistoryRoundTrip({
      type: "update-midi-clip-range",
      clipId: "midi-clip",
      patch: { sourceOffsetTicks: 480, lengthTicks: 2_880 }
    })
    const midiSplit = planMidiClipSplits(
      [mixer.graph.midiClips[0]!],
      2_400,
      (() => {
        const ids = ["midi-right", "note-right"]
        return () => ids.shift() ?? "event-right"
      })()
    )
    if (!midiSplit) throw new Error("MIDI split fixture must cross the playhead")
    await expectOneHistoryRoundTrip(midiSplit)
    await expectOneHistoryRoundTrip({
      type: "update-midi-notes",
      clipId: "midi-clip",
      updates: [{ noteId: "note-1", patch: { key: 67, velocity: 90 } }]
    })
    await expectOneHistoryRoundTrip({ type: "delete-midi-clip", clipId: "midi-right" })
    await expectOneHistoryRoundTrip({
      type: "replace-tempo-map",
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [
          { tick: 0, beatsPerMinute: 110 },
          { tick: 3_840, beatsPerMinute: 132 }
        ],
        timeSignatureEvents: [
          { tick: 0, numerator: 3, denominator: 4 },
          { tick: 5_760, numerator: 6, denominator: 8 }
        ]
      }
    })
    await expectOneHistoryRoundTrip({
      type: "replace-key-signature-map",
      events: [
        { tick: 0, fifths: -3, mode: "minor" },
        { tick: 3_840, fifths: 2, mode: "major" }
      ]
    })

    const beforeFailure = structuredClone(mixer.graph)
    const historyLength = history.undoHistory.length
    vi.mocked(window.yadaw.executeProjectCommand).mockResolvedValueOnce({
      ok: false,
      requestId: "failed-edit",
      error: {
        code: "validation-failed",
        category: "validation",
        outcome: "not-committed",
        retry: "never",
        correlationId: "failed-edit",
        userMessageKey: "errors.invalidRpcRequest",
        details: { type: "validation-failed", field: "projectCommand" }
      }
    })
    await expect(
      mixer.execute({
        type: "update-channel",
        channelId: "audio",
        patch: { gainDb: -12 }
      })
    ).resolves.toBe(false)
    expect(mixer.graph).toEqual(beforeFailure)
    expect(history.undoHistory).toHaveLength(historyLength)
  })

  it("hydrates the ready workspace graph synchronously without reloading the audio host", () => {
    const initial = graph()
    window.yadaw.loadProjectGraph = vi.fn()
    const mixer = useMixerStore()

    mixer.hydrate(initial)

    expect(mixer.graph).toEqual(initial)
    expect(mixer.selectedChannelId).toBe("audio")
    expect(mixer.loading).toBe(false)
    expect(window.yadaw.loadProjectGraph).not.toHaveBeenCalled()
  })

  it("hides output and send targets that would create a routing cycle", () => {
    const mixer = useMixerStore()
    mixer.graph = graph()

    expect(mixer.availableOutputTargets("aux-b")).toContainEqual({
      kind: "output",
      channelId: "output"
    })
    expect(mixer.availableOutputTargets("aux-b")).not.toContainEqual({ kind: "bus", bus: 1 })
    expect(mixer.availableSendTargets("aux-b")).toContainEqual({
      kind: "output",
      channelId: "output"
    })
    expect(mixer.availableSendTargets("aux-b")).not.toContainEqual({ kind: "bus", bus: 1 })
    expect(mixer.availableOutputTargets("master")).toEqual([])
    expect(mixer.availableSendTargets("master")).toEqual([])
  })

  it("creates new sends at the post-pan tap", async () => {
    const initial = graph()
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockImplementation((_meta, command) =>
        Promise.resolve(success({ graph: initial, inverse: command }))
      )
    const mixer = useMixerStore()
    mixer.graph = initial

    await mixer.addSend("audio", { kind: "output", channelId: "output" })

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ target: expect.objectContaining({ kind: "project-graph" }) }),
      {
        type: "create-send",
        send: expect.objectContaining({
          sourceChannelId: "audio",
          targetChannelId: "output",
          targetBus: null,
          enabled: false,
          tap: "post-pan",
          levelDb: -90
        })
      }
    )
  })

  it("uses one default color per channel type and still accepts custom colors", async () => {
    const initial = graph()
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockImplementation((_meta, command) =>
        Promise.resolve(success({ graph: initial, inverse: command }))
      )
    const mixer = useMixerStore()
    mixer.graph = initial

    await mixer.createAudioTrack()
    await mixer.createAux()
    await mixer.createOutput()
    await mixer.updateChannel("audio", { color: "#123456" })

    const commands = vi
      .mocked(window.yadaw.executeProjectCommand)
      .mock.calls.map(([, command]) => command)
    expect(commands[0]).toMatchObject({
      type: "create-track",
      channel: { kind: "audio", color: "#4F8CFF" }
    })
    expect(commands[1]).toMatchObject({
      type: "create-channel",
      channel: {
        kind: "aux",
        color: "#E8B85F",
        inputSource: "bus",
        inputFormat: "stereo",
        inputChannels: [1, 2]
      }
    })
    expect(commands[2]).toMatchObject({
      type: "create-channel",
      channel: { kind: "output", color: "#EF7C95" }
    })
    expect(commands[3]).toEqual({
      type: "update-channel",
      channelId: "audio",
      patch: { color: "#123456" }
    })
  })

  it("creates an unassigned green instrument track", async () => {
    const initial = graph()
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockImplementation((_meta, command) =>
        Promise.resolve(success({ graph: initial, inverse: command }))
      )
    const mixer = useMixerStore()
    mixer.graph = initial

    await mixer.createInstrumentTrack()

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledWith(expect.any(Object), {
      type: "create-track",
      track: expect.objectContaining({ channelId: expect.any(String), sortOrder: 0 }),
      channel: expect.objectContaining({
        kind: "instrument",
        name: "Instrument 1",
        color: "#73D6A2",
        inputSource: null,
        inputFormat: null,
        midiInput: { portId: null, portName: null, channel: null },
        inputChannels: [],
        recordArmed: false,
        inputMonitoring: true,
        outputChannelId: "output"
      })
    })
  })

  it("keeps the metronome in Mixer only and toggles mute without Undo history", async () => {
    const initial = graph()
    const enabled = structuredClone(initial)
    const metronome = enabled.channels.find((channel) => channel.systemRole === "metronome")
    if (!metronome) throw new Error("test graph requires metronome")
    metronome.muted = false
    window.yadaw.executeProjectCommand = vi.fn().mockResolvedValue(
      success({
        graph: enabled,
        inverse: { type: "update-channel", channelId: "metronome", patch: { muted: true } }
      })
    )
    const mixer = useMixerStore()
    mixer.graph = initial

    expect(mixer.instrumentTracks).toEqual([])
    expect(mixer.timelineTracks.map((channel) => channel.id)).toEqual(["audio"])
    expect(mixer.orderedChannels.map((channel) => channel.id)).toContain("metronome")
    await mixer.toggleMetronome()

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledWith(expect.any(Object), {
      type: "update-channel",
      channelId: "metronome",
      patch: { muted: false }
    })
    expect(mixer.metronome?.muted).toBe(false)
    expect(mixer.canUndo).toBe(false)
    await expect(mixer.deleteChannel("metronome")).resolves.toBe(false)
  })

  it("serializes committed commands before starting the next mutation", async () => {
    const initial = graph()
    const firstGraph = structuredClone(initial)
    firstGraph.channels[0]!.gainDb = -3
    const secondGraph = structuredClone(firstGraph)
    secondGraph.channels[0]!.pan = 0.5
    let resolveFirst!: (value: unknown) => void
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(
        success({
          graph: secondGraph,
          inverse: { type: "update-channel", channelId: "audio", patch: { pan: 0 } }
        })
      )
    const mixer = useMixerStore()
    mixer.graph = initial

    const first = mixer.updateChannel("audio", { gainDb: -3 })
    const second = mixer.updateChannel("audio", { pan: 0.5 })
    await vi.waitFor(() => {
      expect(window.yadaw.executeProjectCommand).toHaveBeenCalledTimes(1)
    })

    resolveFirst(
      success({
        graph: firstGraph,
        inverse: { type: "update-channel", channelId: "audio", patch: { gainDb: 0 } }
      })
    )
    await first
    await second

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledTimes(2)
    expect(mixer.graph.channels[0]).toMatchObject({ gainDb: -3, pan: 0.5 })
  })

  it("clears latched meter clipping in the UI and native engine", async () => {
    window.yadaw.clearMixerMeterClips = vi.fn().mockResolvedValue(
      success({
        capturedAt: 2,
        meters: [
          {
            channelId: "audio",
            preFaderPeak: [1, 1],
            postFaderPeak: [1, 1],
            heldPeak: [0, 0],
            clipped: false
          }
        ]
      })
    )
    const mixer = useMixerStore()
    mixer.runtime = {
      capturedAt: 1,
      meters: [
        {
          channelId: "audio",
          preFaderPeak: [1, 1],
          postFaderPeak: [1, 1],
          heldPeak: [1, 1],
          clipped: true
        }
      ]
    }

    await mixer.clearMeterClips()

    expect(mixer.runtime.meters[0]).toMatchObject({
      heldPeak: [0, 0],
      clipped: false
    })
    expect(window.yadaw.clearMixerMeterClips).toHaveBeenCalledOnce()
  })
})

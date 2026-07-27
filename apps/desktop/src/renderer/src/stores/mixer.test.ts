import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { MixerGraphSnapshot, ProjectSession } from "@yadaw/contracts"
import { useProjectStore } from "./project"
import { useMixerStore } from "./mixer"

function graph(): MixerGraphSnapshot {
  return {
    sampleRate: 48_000,
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
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ],
    clips: [],
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

describe("mixer store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().applyLifecycleState({
      status: "open",
      session: structuredClone(session),
      error: null
    })
  })

  it("records one history entry and applies the inverse on undo", async () => {
    const initial = graph()
    const changed = structuredClone(initial)
    changed.channels[0]!.gainDb = -6
    window.yadaw.loadMixerGraph = vi.fn().mockResolvedValue(initial)
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockResolvedValueOnce({
        graph: changed,
        inverse: { type: "update-channel", channelId: "audio", patch: { gainDb: 0 } }
      })
      .mockResolvedValueOnce({
        graph: initial,
        inverse: { type: "update-channel", channelId: "audio", patch: { gainDb: -6 } }
      })

    const mixer = useMixerStore()
    await mixer.load()
    await mixer.updateChannel("audio", { gainDb: -6 })
    expect(mixer.graph.channels[0]?.gainDb).toBe(-6)
    expect(mixer.canUndo).toBe(true)

    await mixer.undo()
    expect(mixer.graph.channels[0]?.gainDb).toBe(0)
    expect(window.yadaw.executeProjectCommand).toHaveBeenLastCalledWith({
      type: "update-channel",
      channelId: "audio",
      patch: { gainDb: 0 }
    })
    expect(mixer.canRedo).toBe(true)
  })

  it("hydrates the ready workspace graph synchronously without reloading the audio host", () => {
    const initial = graph()
    window.yadaw.loadMixerGraph = vi.fn()
    const mixer = useMixerStore()

    mixer.hydrate(initial)

    expect(mixer.graph).toEqual(initial)
    expect(mixer.selectedChannelId).toBe("audio")
    expect(mixer.loading).toBe(false)
    expect(window.yadaw.loadMixerGraph).not.toHaveBeenCalled()
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
      .mockImplementation((command) => Promise.resolve({ graph: initial, inverse: command }))
    const mixer = useMixerStore()
    mixer.graph = initial

    await mixer.addSend("audio", { kind: "output", channelId: "output" })

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledWith({
      type: "create-send",
      send: expect.objectContaining({
        sourceChannelId: "audio",
        targetChannelId: "output",
        targetBus: null,
        enabled: false,
        tap: "post-pan",
        levelDb: -90
      })
    })
  })

  it("uses one default color per channel type and still accepts custom colors", async () => {
    const initial = graph()
    window.yadaw.executeProjectCommand = vi
      .fn()
      .mockImplementation((command) => Promise.resolve({ graph: initial, inverse: command }))
    const mixer = useMixerStore()
    mixer.graph = initial

    await mixer.createAudioTrack()
    await mixer.createAux()
    await mixer.createOutput()
    await mixer.updateChannel("audio", { color: "#123456" })

    const commands = vi
      .mocked(window.yadaw.executeProjectCommand)
      .mock.calls.map(([command]) => command)
    expect(commands[0]).toMatchObject({
      type: "create-channel",
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
      .mockImplementation((command) => Promise.resolve({ graph: initial, inverse: command }))
    const mixer = useMixerStore()
    mixer.graph = initial

    await mixer.createInstrumentTrack()

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledWith({
      type: "create-channel",
      channel: expect.objectContaining({
        kind: "instrument",
        name: "Instrument 1",
        color: "#73D6A2",
        inputSource: null,
        inputFormat: null,
        inputChannels: [],
        recordArmed: false,
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
    window.yadaw.executeProjectCommand = vi.fn().mockResolvedValue({
      graph: enabled,
      inverse: { type: "update-channel", channelId: "metronome", patch: { muted: true } }
    })
    const mixer = useMixerStore()
    mixer.graph = initial

    expect(mixer.instrumentTracks).toEqual([])
    expect(mixer.timelineTracks.map((channel) => channel.id)).toEqual(["audio"])
    expect(mixer.orderedChannels.map((channel) => channel.id)).toContain("metronome")
    await mixer.toggleMetronome()

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledWith({
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
      .mockResolvedValueOnce({
        graph: secondGraph,
        inverse: { type: "update-channel", channelId: "audio", patch: { pan: 0 } }
      })
    const mixer = useMixerStore()
    mixer.graph = initial

    const first = mixer.updateChannel("audio", { gainDb: -3 })
    const second = mixer.updateChannel("audio", { pan: 0.5 })
    await vi.waitFor(() => {
      expect(window.yadaw.executeProjectCommand).toHaveBeenCalledTimes(1)
    })

    resolveFirst({
      graph: firstGraph,
      inverse: { type: "update-channel", channelId: "audio", patch: { gainDb: 0 } }
    })
    await first
    await second

    expect(window.yadaw.executeProjectCommand).toHaveBeenCalledTimes(2)
    expect(mixer.graph.channels[0]).toMatchObject({ gainDb: -3, pan: 0.5 })
  })

  it("clears latched meter clipping in the UI and native engine", async () => {
    window.yadaw.clearMixerMeterClips = vi.fn().mockResolvedValue({
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

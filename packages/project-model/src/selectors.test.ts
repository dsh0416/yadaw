import { describe, expect, it } from "vitest"
import type {
  MixerChannelState,
  MixerRuntimeSnapshot,
  ProjectGraphSnapshot
} from "@heron/contracts"
import {
  MIXER_BUSES,
  audioTracks,
  availableOutputTargets,
  availableSendTargets,
  channelForTrack,
  instrumentTracks,
  meterFor,
  patchMixerGraph,
  projectContentEndSeconds,
  sendsFor,
  systemChannels
} from "./selectors"

function channel(overrides: Partial<MixerChannelState>): MixerChannelState {
  return {
    id: "channel",
    kind: "audio",
    systemRole: null,
    name: "Channel",
    color: "#8C83FF",
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
    hardwareOutputChannels: [],
    ...overrides
  }
}

function graph(overrides: Partial<ProjectGraphSnapshot> = {}): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [
      { id: "track:audio", channelId: "audio", sortOrder: 0 },
      { id: "track:instrument", channelId: "instrument", sortOrder: 1 }
    ],
    channels: [
      channel({
        id: "audio",
        kind: "audio",
        name: "Audio",
        inputSource: "hardware",
        inputFormat: "stereo",
        inputChannels: [1, 2]
      }),
      channel({
        id: "instrument",
        kind: "instrument",
        name: "Instrument",
        color: "#73D6A2",
        sortOrder: 1,
        midiInput: { portId: null, portName: null, channel: null }
      }),
      channel({
        id: "aux-a",
        kind: "aux",
        name: "Aux A",
        color: "#E8B85F",
        inputSource: "bus",
        inputFormat: "mono",
        inputChannels: [1]
      }),
      channel({
        id: "aux-b",
        kind: "aux",
        name: "Aux B",
        color: "#E8B85F",
        sortOrder: 1,
        inputSource: "bus",
        inputFormat: "mono",
        inputChannels: [2]
      }),
      channel({
        id: "metronome",
        kind: "instrument",
        systemRole: "metronome",
        name: "Metronome",
        color: "#AD8CFF",
        muted: true
      }),
      channel({
        id: "master",
        kind: "master",
        name: "Master",
        color: "#67D9E7",
        outputChannelId: null
      }),
      channel({
        id: "output",
        kind: "output",
        name: "Output 1–2",
        color: "#73D6A2",
        outputChannelId: null,
        hardwareOutputChannels: [1, 2]
      })
    ],
    audioClips: [],
    sends: [
      {
        id: "aux-a-to-bus-2",
        sourceChannelId: "aux-a",
        targetChannelId: null,
        targetBus: 2,
        sortOrder: 0,
        enabled: true,
        tap: "post-pan",
        levelDb: -12
      },
      {
        id: "audio-to-output",
        sourceChannelId: "audio",
        targetChannelId: "output",
        targetBus: null,
        sortOrder: 0,
        enabled: false,
        tap: "post-pan",
        levelDb: -90
      }
    ],
    plugins: [],
    midiClips: [],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [
        { tick: 0, beatsPerMinute: 120 },
        { tick: 960, beatsPerMinute: 60 }
      ],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    },
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
    ...overrides
  }
}

describe("patchMixerGraph", () => {
  it("patches matching channels, sends, and plugins without mutating the original", () => {
    const before = graph()
    before.plugins.push({
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
    })
    const patchedChannel = patchMixerGraph(before, "channel", "audio", { gainDb: -6, pan: 0.5 })
    const patchedSend = patchMixerGraph(before, "send", "audio-to-output", { levelDb: -6 })
    const patchedPlugin = patchMixerGraph(before, "plugin", "effect", { enabled: false })

    expect(before.channels.find((candidate) => candidate.id === "audio")?.gainDb).toBe(0)
    expect(patchedChannel.channels.find((candidate) => candidate.id === "audio")).toMatchObject({
      gainDb: -6,
      pan: 0.5
    })
    expect(patchedSend.sends.find((candidate) => candidate.id === "audio-to-output")?.levelDb).toBe(
      -6
    )
    expect(before.plugins[0]?.enabled).toBe(true)
    expect(patchedPlugin.plugins[0]?.enabled).toBe(false)
  })

  it("leaves the graph unchanged when the id is missing", () => {
    const before = graph()
    expect(patchMixerGraph(before, "channel", "missing", { gainDb: 1 })).toEqual(before)
  })
})

describe("track and channel selectors", () => {
  it("partitions audio, instrument, and system channels", () => {
    const channels = graph().channels

    expect(audioTracks(channels).map((candidate) => candidate.id)).toEqual(["audio"])
    expect(instrumentTracks(channels).map((candidate) => candidate.id)).toEqual(["instrument"])
    expect(systemChannels(channels).map((candidate) => candidate.id)).toEqual(["metronome"])
  })

  it("resolves channels for tracks and misses unknown tracks", () => {
    const value = graph()

    expect(channelForTrack(value, "track:audio")?.id).toBe("audio")
    expect(channelForTrack(value, "track:missing")).toBeUndefined()
  })

  it("lists sends for a source channel", () => {
    const value = graph()

    expect(sendsFor(value, "audio").map((send) => send.id)).toEqual(["audio-to-output"])
    expect(sendsFor(value, "instrument")).toEqual([])
  })
})

describe("meterFor", () => {
  it("returns the matching meter or a silent default", () => {
    const runtime: MixerRuntimeSnapshot = {
      capturedAt: 1,
      meters: [
        {
          channelId: "audio",
          preFaderPeak: [0.5, 0.25],
          postFaderPeak: [0.4, 0.2],
          heldPeak: [0.6, 0.3],
          clipped: true
        }
      ]
    }

    expect(meterFor(runtime, "audio")).toEqual(runtime.meters[0])
    expect(meterFor(runtime, "missing")).toEqual({
      channelId: "missing",
      preFaderPeak: [0, 0],
      postFaderPeak: [0, 0],
      heldPeak: [0, 0],
      clipped: false
    })
  })
})

describe("projectContentEndSeconds", () => {
  it("uses the later of audio frame and midi tick ends across tempo changes", () => {
    const value = graph({
      audioClips: [
        {
          id: "audio-clip",
          assetId: "asset",
          trackId: "track:audio",
          name: "Audio",
          startFrame: 0,
          sourceOffsetFrames: 0,
          lengthFrames: 48_000,
          sourceLengthFrames: 48_000,
          fadeInFrames: 0,
          fadeOutFrames: 0,
          assetSampleRate: 48_000,
          assetChannels: 2
        }
      ],
      midiClips: [
        {
          id: "midi-clip",
          sourceId: "source",
          trackId: "track:instrument",
          name: "Midi",
          startTick: 0,
          lengthTicks: 1_920,
          sourceOffsetTicks: 0,
          sourceLengthTicks: 1_920,
          notes: [],
          events: []
        }
      ]
    })

    // 960 ticks at 120 bpm = 0.5s, then 960 ticks at 60 bpm = 1.0s => midi end 1.5s
    expect(projectContentEndSeconds(value)).toBe(1.5)
  })
})

describe("available routing targets", () => {
  it("exposes mixer buses and output channels", () => {
    expect(MIXER_BUSES).toHaveLength(256)
    expect(MIXER_BUSES[0]).toEqual({ channel: 1, name: "BUS 1" })
  })

  it("returns no output/send targets for master and unknown channels", () => {
    const value = graph()

    expect(availableOutputTargets(value, "master")).toEqual([])
    expect(availableSendTargets(value, "master")).toEqual([])
    expect(availableOutputTargets(value, "missing")).toEqual([])
    expect(availableSendTargets(value, "missing")).toEqual([])
  })

  it("excludes cyclic bus routes for aux channels", () => {
    const value = graph()

    expect(availableOutputTargets(value, "aux-b")).toContainEqual({
      kind: "output",
      channelId: "output"
    })
    expect(availableOutputTargets(value, "aux-b")).not.toContainEqual({ kind: "bus", bus: 1 })
    expect(availableSendTargets(value, "aux-b")).toContainEqual({
      kind: "output",
      channelId: "output"
    })
    expect(availableSendTargets(value, "aux-b")).not.toContainEqual({ kind: "bus", bus: 1 })
  })

  it("filters send targets that already exist for the source channel", () => {
    const value = graph()

    expect(availableSendTargets(value, "audio")).not.toContainEqual({
      kind: "output",
      channelId: "output"
    })
    expect(availableSendTargets(value, "audio")).toContainEqual({ kind: "bus", bus: 1 })
    expect(availableSendTargets(value, "audio")).toContainEqual({ kind: "bus", bus: 3 })
  })
})

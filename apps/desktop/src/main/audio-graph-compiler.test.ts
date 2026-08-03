import { describe, expect, it } from "vitest"
import type { PluginDescriptor, PluginInstanceState, ProjectGraphSnapshot } from "@heron/contracts"
import { AudioGraphCompiler } from "./audio-graph-compiler"

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "effect-class",
  modulePath: "/plugins/Effect.vst3",
  name: "Effect",
  vendor: "Heron Studio",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["stereo"],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

const plugin: PluginInstanceState = {
  id: "plugin-1",
  channelId: "audio-1",
  role: "insert",
  slotOrder: 0,
  classId: descriptor.classId,
  descriptor,
  audioMode: "stereo",
  enabled: true,
  sidechainInputs: [],
  componentState: new Uint8Array([1]),
  controllerState: new Uint8Array([2])
}

function snapshot(overrides: Partial<ProjectGraphSnapshot> = {}): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [
      { id: "track:audio-1", channelId: "audio-1", sortOrder: 0 },
      { id: "track:instrument-1", channelId: "instrument-1", sortOrder: 1 }
    ],
    channels: [
      {
        id: "audio-1",
        kind: "audio",
        systemRole: null,
        name: "Audio 1",
        color: "#8C83FF",
        sortOrder: 0,
        inputSource: "hardware",
        inputFormat: "stereo",
        gainDb: -3,
        pan: 0.25,
        muted: false,
        soloed: true,
        outputChannelId: "output",
        outputBus: null,
        recordArmed: true,
        inputMonitoring: true,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      },
      {
        id: "instrument-1",
        kind: "instrument",
        systemRole: null,
        name: "Instrument 1",
        color: "#73D6A2",
        sortOrder: 1,
        inputSource: null,
        inputFormat: null,
        midiInput: { portId: "midi-1", portName: "Keyboard", channel: 3 },
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        outputBus: null,
        recordArmed: false,
        inputMonitoring: true,
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
    audioClips: [
      {
        id: "audio-clip-1",
        assetId: "asset-1",
        trackId: "track:audio-1",
        name: "Take",
        startFrame: 480,
        sourceOffsetFrames: 10,
        lengthFrames: 960,
        sourceLengthFrames: 970,
        fadeInFrames: 48,
        fadeOutFrames: 96,
        assetSampleRate: 48_000,
        assetChannels: 2
      }
    ],
    sends: [
      {
        id: "send-1",
        sourceChannelId: "audio-1",
        targetChannelId: null,
        targetBus: 1,
        sortOrder: 0,
        enabled: true,
        tap: "post-pan",
        levelDb: -12
      }
    ],
    plugins: [plugin],
    midiClips: [
      {
        id: "midi-clip-1",
        sourceId: "source-1",
        trackId: "track:instrument-1",
        name: "Phrase",
        startTick: 0,
        lengthTicks: 960,
        sourceOffsetTicks: 0,
        sourceLengthTicks: Number.MAX_SAFE_INTEGER,
        notes: [
          {
            id: "note-1",
            startTick: 0,
            durationTicks: 240,
            channel: 0,
            key: 60,
            velocity: 100,
            releaseVelocity: 0
          }
        ],
        events: [
          {
            id: "event-1",
            tick: 0,
            channel: 0,
            kind: "control-change",
            data: new Uint8Array([0xb0, 7, 100])
          }
        ]
      }
    ],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [
        { tick: 0, beatsPerMinute: 120 },
        { tick: 1920, beatsPerMinute: 140 }
      ],
      timeSignatureEvents: [
        { tick: 0, numerator: 4, denominator: 4 },
        { tick: 3840, numerator: 3, denominator: 4 }
      ]
    },
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
    ...overrides
  }
}

describe("AudioGraphCompiler", () => {
  const compiler = new AudioGraphCompiler()
  const assetPaths = new Map([["asset-1", "/assets/take.wav"]])

  it("compiles channels, sends, clips, plugins, midi, and tempo maps", () => {
    const compiled = compiler.compile(snapshot(), assetPaths, true)

    expect(compiled.sample_rate).toBe(48_000)
    expect(compiled.channels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "audio-1",
          kind: "audio",
          gain_db: -3,
          pan: 0.25,
          soloed: true,
          record_armed: true,
          input_monitoring: true,
          input_source: "hardware",
          input_channels: [1, 2],
          output_channel_id: "output"
        }),
        expect.objectContaining({
          id: "instrument-1",
          kind: "instrument",
          input_monitoring: true,
          midi_input_port_id: "midi-1",
          midi_input_port_name: "Keyboard",
          midi_input_channel: 3
        })
      ])
    )
    expect(compiled.sends).toEqual([
      expect.objectContaining({
        id: "send-1",
        source_channel_id: "audio-1",
        target_bus: 1,
        enabled: true,
        tap: "post-pan",
        level_db: -12
      })
    ])
    expect(compiled.clips).toEqual([
      {
        id: "audio-clip-1",
        channel_id: "audio-1",
        start_frame: 480,
        source_offset_frames: 10,
        length_frames: 960,
        fade_in_frames: 48,
        fade_out_frames: 96,
        path: "/assets/take.wav"
      }
    ])
    expect(compiled.plugins).toEqual([
      expect.objectContaining({
        instance_id: "plugin-1",
        channel_id: "audio-1",
        role: "insert",
        slot_order: 0,
        audio_mode: "stereo",
        enabled: true,
        latency_samples: 0,
        tail_samples: 0
      })
    ])
    expect(compiled.midi_clips).toEqual([
      expect.objectContaining({
        id: "midi-clip-1",
        channel_id: "instrument-1",
        start_tick: 0,
        length_ticks: 960,
        notes: {
          storage: "inline",
          notes: [
            expect.objectContaining({
              start_tick: 0,
              duration_ticks: 240,
              key: 60,
              velocity: 100
            })
          ]
        },
        events: {
          storage: "inline",
          events: [
            expect.objectContaining({
              tick: 0,
              kind: "control-change",
              data: { storage: "inline", bytes: new Uint8Array([0xb0, 7, 100]) }
            })
          ]
        }
      })
    ])
    expect(compiled.tempo_events).toEqual([
      { tick: 0, beats_per_minute: 120 },
      { tick: 1920, beats_per_minute: 140 }
    ])
    expect(compiled.time_signature_events).toEqual([
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3840, numerator: 3, denominator: 4 }
    ])
  })

  it("gates audio monitoring on softwareMonitoringEnabled while instruments keep theirs", () => {
    const graph = snapshot()
    const monitored = compiler.compile(graph, assetPaths, true)
    const unmonitored = compiler.compile(graph, assetPaths, false)

    expect(monitored.channels.find((channel) => channel.id === "audio-1")?.input_monitoring).toBe(
      true
    )
    expect(unmonitored.channels.find((channel) => channel.id === "audio-1")?.input_monitoring).toBe(
      false
    )
    expect(
      unmonitored.channels.find((channel) => channel.id === "instrument-1")?.input_monitoring
    ).toBe(true)
  })

  it("disables audio monitoring when the channel is not hardware-monitored", () => {
    const graph = snapshot()
    const audio = graph.channels.find((channel) => channel.id === "audio-1")!
    audio.inputMonitoring = false
    expect(
      compiler.compile(graph, assetPaths, true).channels.find((channel) => channel.id === "audio-1")
        ?.input_monitoring
    ).toBe(false)

    audio.inputMonitoring = true
    audio.inputSource = "bus"
    expect(
      compiler.compile(graph, assetPaths, true).channels.find((channel) => channel.id === "audio-1")
        ?.input_monitoring
    ).toBe(false)
  })

  it("throws when a clip references a missing track", () => {
    const graph = snapshot()
    graph.audioClips[0]!.trackId = "track:missing"

    expect(() => compiler.compile(graph, assetPaths, false)).toThrow(
      "Project track 'track:missing' was not found"
    )
  })
})

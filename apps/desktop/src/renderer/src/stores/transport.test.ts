import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type {
  ProjectGraphSnapshot,
  PluginInstanceState,
  PluginRuntimeStatus,
  TransportSnapshot
} from "@yadaw/contracts"
import type { ProjectAssetSummary as Asset } from "@yadaw/contracts"
import { assetsToTimelineClips, useTransportStore } from "./transport"
import { useMixerStore } from "./mixer"
import { usePluginStore } from "./plugins"

function asset(id: string, frameCount: bigint, sampleRate = 48_000): Asset {
  return {
    id,
    name: `${id}.bwf`,
    sampleRate,
    channels: 2,
    bitDepth: "float32",
    frameCount
  }
}

function effectInstance(id: string): PluginInstanceState {
  return {
    id,
    channelId: "audio-1",
    role: "insert",
    slotOrder: 0,
    classId: "class-1",
    descriptor: {
      source: { kind: "external" },
      classId: "class-1",
      modulePath: "/plugins/reverb.vst3",
      name: "Reverb",
      vendor: "Vendor",
      version: "1.0",
      categories: ["Fx"],
      kind: "effect",
      supportedAudioModes: ["stereo"],
      architecture: "x86_64",
      buses: [],
      hasEditor: false,
      compatibility: "compatible",
      compatibilityReason: null
    },
    audioMode: "stereo",
    enabled: true,
    componentState: new Uint8Array(),
    controllerState: new Uint8Array()
  }
}

function activeRuntime(instanceId: string, tailSamples: number | null): PluginRuntimeStatus {
  return {
    instanceId,
    state: "active",
    editorOpen: false,
    latencySamples: 0,
    tailSamples,
    error: null
  }
}

const emptyGraph: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [],
  channels: [],
  audioClips: [],
  sends: [],
  plugins: [],
  midiClips: [],
  keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  }
}

describe("transport store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useMixerStore().graph = structuredClone(emptyGraph)
  })

  it("lays project recordings out consecutively using their real frame durations", () => {
    const clips = assetsToTimelineClips([asset("take-one", 96_000n), asset("take-two", 24_000n)])

    expect(clips).toMatchObject([
      { id: "take-one", name: "take-one", startSeconds: 0, durationSeconds: 2, endSeconds: 2 },
      { id: "take-two", name: "take-two", startSeconds: 2, durationSeconds: 0.5, endSeconds: 2.5 }
    ])
  })

  it("ignores a stale polling response that resolves last", async () => {
    let resolveOld!: (value: TransportSnapshot) => void
    const old = new Promise<TransportSnapshot>((resolve) => {
      resolveOld = resolve
    })
    window.yadaw.transportSnapshot = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({ state: "playing", positionFrames: 200, sampleRate: 48_000 })
    const transport = useTransportStore()

    const first = transport.refresh()
    const second = transport.refresh()
    await second
    resolveOld({ state: "stopped", positionFrames: 10, sampleRate: 48_000 })
    await first

    expect(transport.snapshot).toMatchObject({ state: "playing", positionFrames: 200 })
  })

  it("coalesces same-turn seek requests to the latest position", async () => {
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      state: "stopped",
      positionFrames: 144_000,
      sampleRate: 48_000
    })
    const transport = useTransportStore()

    transport.seek(1)
    transport.seek(2)
    transport.seek(3)
    await Promise.resolve()
    await Promise.resolve()

    expect(window.yadaw.transportCommand).toHaveBeenCalledOnce()
    expect(window.yadaw.transportCommand).toHaveBeenCalledWith({
      type: "seek",
      positionFrames: 144_000
    })
  })

  it("can play an empty project while the metronome system channel is enabled", async () => {
    const mixer = useMixerStore()
    mixer.graph = {
      ...structuredClone(emptyGraph),
      channels: [
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
          muted: false,
          soloed: false,
          outputChannelId: "output",
          recordArmed: false,
          inputMonitoring: false,
          inputChannels: [],
          hardwareOutputChannels: []
        }
      ]
    }
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      state: "playing",
      positionFrames: 0,
      sampleRate: 48_000
    })
    const transport = useTransportStore()

    expect(transport.canPlay).toBe(true)
    await transport.play()

    expect(window.yadaw.transportCommand).toHaveBeenCalledWith({ type: "play" })
  })

  it("rewinds to the start before playing when the playhead is at the content end", async () => {
    const mixer = useMixerStore()
    mixer.graph = {
      ...structuredClone(emptyGraph),
      audioClips: [
        {
          id: "clip-1",
          name: "Clip",
          trackId: "track:audio-1",
          assetId: "asset-1",
          assetChannels: 2,
          assetSampleRate: 48_000,
          startFrame: 0,
          sourceOffsetFrames: 0,
          lengthFrames: 48_000
        }
      ]
    }
    window.yadaw.transportCommand = vi
      .fn()
      .mockResolvedValueOnce({
        state: "stopped",
        positionFrames: 0,
        sampleRate: 48_000
      })
      .mockResolvedValueOnce({
        state: "playing",
        positionFrames: 0,
        sampleRate: 48_000
      })
    const transport = useTransportStore()
    transport.snapshot = {
      state: "stopped",
      positionFrames: 48_000,
      sampleRate: 48_000
    }

    await transport.play()

    expect(window.yadaw.transportCommand).toHaveBeenNthCalledWith(1, {
      type: "seek",
      positionFrames: 0
    })
    expect(window.yadaw.transportCommand).toHaveBeenNthCalledWith(2, { type: "play" })
  })

  it("keeps the playhead when paused inside a finite plugin tail window", async () => {
    const mixer = useMixerStore()
    mixer.graph = {
      ...structuredClone(emptyGraph),
      audioClips: [
        {
          id: "clip-1",
          name: "Clip",
          trackId: "track:audio-1",
          assetId: "asset-1",
          assetChannels: 2,
          assetSampleRate: 48_000,
          startFrame: 0,
          sourceOffsetFrames: 0,
          lengthFrames: 48_000
        }
      ],
      plugins: [effectInstance("reverb-1")]
    }
    usePluginStore().runtime = { "reverb-1": activeRuntime("reverb-1", 48_000) }
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      state: "playing",
      positionFrames: 60_000,
      sampleRate: 48_000
    })
    const transport = useTransportStore()
    // Paused past the content end but before the tail finishes decaying.
    transport.snapshot = {
      state: "stopped",
      positionFrames: 60_000,
      sampleRate: 48_000
    }

    await transport.play()

    expect(window.yadaw.transportCommand).toHaveBeenCalledOnce()
    expect(window.yadaw.transportCommand).toHaveBeenCalledWith({ type: "play" })
  })

  it("rewinds before playing once the playhead reaches the end of the plugin tail", async () => {
    const mixer = useMixerStore()
    mixer.graph = {
      ...structuredClone(emptyGraph),
      audioClips: [
        {
          id: "clip-1",
          name: "Clip",
          trackId: "track:audio-1",
          assetId: "asset-1",
          assetChannels: 2,
          assetSampleRate: 48_000,
          startFrame: 0,
          sourceOffsetFrames: 0,
          lengthFrames: 48_000
        }
      ],
      plugins: [effectInstance("reverb-1")]
    }
    usePluginStore().runtime = { "reverb-1": activeRuntime("reverb-1", 48_000) }
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      state: "stopped",
      positionFrames: 0,
      sampleRate: 48_000
    })
    const transport = useTransportStore()
    transport.snapshot = {
      state: "stopped",
      positionFrames: 96_000,
      sampleRate: 48_000
    }

    await transport.play()

    expect(window.yadaw.transportCommand).toHaveBeenNthCalledWith(1, {
      type: "seek",
      positionFrames: 0
    })
    expect(window.yadaw.transportCommand).toHaveBeenNthCalledWith(2, { type: "play" })
  })

  it("never auto-rewinds while a plugin reports an unbounded tail", async () => {
    const mixer = useMixerStore()
    mixer.graph = {
      ...structuredClone(emptyGraph),
      audioClips: [
        {
          id: "clip-1",
          name: "Clip",
          trackId: "track:audio-1",
          assetId: "asset-1",
          assetChannels: 2,
          assetSampleRate: 48_000,
          startFrame: 0,
          sourceOffsetFrames: 0,
          lengthFrames: 48_000
        }
      ],
      plugins: [effectInstance("freeze-1")]
    }
    usePluginStore().runtime = { "freeze-1": activeRuntime("freeze-1", null) }
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      state: "playing",
      positionFrames: 240_000,
      sampleRate: 48_000
    })
    const transport = useTransportStore()
    transport.snapshot = {
      state: "stopped",
      positionFrames: 240_000,
      sampleRate: 48_000
    }

    await transport.play()

    expect(window.yadaw.transportCommand).toHaveBeenCalledOnce()
    expect(window.yadaw.transportCommand).toHaveBeenCalledWith({ type: "play" })
  })

  it("can play a MIDI-only project and treats MIDI length as content end", async () => {
    const mixer = useMixerStore()
    mixer.graph = {
      ...structuredClone(emptyGraph),
      midiClips: [
        {
          id: "midi-1",
          sourceId: "source-1",
          name: "Midi",
          trackId: "track:instrument-1",
          startTick: 0,
          lengthTicks: 3_840,
          sourceOffsetTicks: 0,
          notes: [],
          events: []
        }
      ]
    }
    window.yadaw.transportCommand = vi.fn().mockResolvedValue({
      state: "playing",
      positionFrames: 0,
      sampleRate: 48_000
    })
    const transport = useTransportStore()

    expect(transport.canPlay).toBe(true)
    expect(transport.contentEndSeconds).toBe(2)
    await transport.play()
    expect(window.yadaw.transportCommand).toHaveBeenCalledWith({ type: "play" })
  })
})

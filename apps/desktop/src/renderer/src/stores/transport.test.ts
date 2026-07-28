import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { MixerGraphSnapshot, TransportSnapshot } from "@yadaw/contracts"
import type { ProjectAssetSummary as Asset } from "@yadaw/contracts"
import { assetsToTimelineClips, useTransportStore } from "./transport"
import { useMixerStore } from "./mixer"

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

const emptyGraph: MixerGraphSnapshot = {
  sampleRate: 48_000,
  channels: [],
  clips: [],
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
})

import { describe, expect, it, vi } from "vitest"
import type { ProjectGraphSnapshot } from "@heron/contracts"
import type { AudioGraphPublisher } from "./audio-graph-publisher"
import { ProjectGraphService } from "./project-graph-service"
import type { ProjectService } from "./project-service"

function graph(): ProjectGraphSnapshot {
  return {
    sampleRate: 48_000,
    tracks: [],
    channels: [
      {
        id: "output",
        kind: "output",
        systemRole: null,
        name: "Output 1–2",
        color: "#000000",
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
    midiClips: [],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    },
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
  }
}

describe("ProjectGraphService Low Latency Mode", () => {
  it("restores normal policy when persisting a newly enabled budget fails", async () => {
    const source = graph()
    const publish = vi.fn(async () => structuredClone(source))
    const publisher = {
      resolve: vi.fn((value: ProjectGraphSnapshot) => structuredClone(value)),
      publish,
      lowLatencyPluginBudgetMs: vi.fn(async () => 5),
      setLowLatencyPluginBudgetMs: vi.fn(async () => {
        throw new Error("settings-write-failed")
      }),
      compiledAudioGraphSnapshot: vi.fn(async () => null)
    } as unknown as AudioGraphPublisher
    const projects = { current: { id: "project" } } as unknown as ProjectService
    const service = new ProjectGraphService(projects, publisher)
    service.commit("project", source)

    await expect(
      service.configureLowLatencyMode({ enabled: true, pluginBudgetMs: 10 })
    ).rejects.toThrow("settings-write-failed")

    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenNthCalledWith(1, expect.anything(), {
      latencyPolicy: {
        type: "low-latency",
        targetOutputChannelId: "output",
        pluginBudgetSamples: 480
      },
      awaitPublication: true
    })
    expect(publish).toHaveBeenNthCalledWith(2, expect.anything(), {
      latencyPolicy: { type: "normal" },
      awaitPublication: true
    })
    await expect(service.lowLatencySnapshot()).resolves.toMatchObject({
      enabled: false,
      targetOutputChannelId: "output",
      pluginBudgetMs: 5
    })
  })
})

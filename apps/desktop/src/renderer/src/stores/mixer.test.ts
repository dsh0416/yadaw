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
        id: "audio", kind: "audio", name: "Audio", color: "#8C83FF", sortOrder: 0,
        channelFormat: "stereo", gainDb: 0, pan: 0, muted: false, soloed: false,
        outputChannelId: "bus-a", recordArmed: false, inputChannels: [1, 2]
      },
      {
        id: "bus-a", kind: "bus", name: "Bus A", color: "#E8B85F", sortOrder: 0,
        channelFormat: "stereo", gainDb: 0, pan: 0, muted: false, soloed: false,
        outputChannelId: "bus-b", recordArmed: false, inputChannels: []
      },
      {
        id: "bus-b", kind: "bus", name: "Bus B", color: "#E8B85F", sortOrder: 1,
        channelFormat: "stereo", gainDb: 0, pan: 0, muted: false, soloed: false,
        outputChannelId: "master", recordArmed: false, inputChannels: []
      },
      {
        id: "master", kind: "master", name: "Master", color: "#67D9E7", sortOrder: 0,
        channelFormat: "stereo", gainDb: 0, pan: 0, muted: false, soloed: false,
        outputChannelId: null, recordArmed: false, inputChannels: []
      }
    ],
    clips: [],
    sends: []
  }
}

const session: ProjectSession = {
  id: "project",
  path: "project.yadaw",
  configuration: {
    name: "Mixer test",
    sampleRate: 48_000,
    tempo: 120,
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
    useProjectStore().session = structuredClone(session)
  })

  it("records one history entry and applies the inverse on undo", async () => {
    const initial = graph()
    const changed = structuredClone(initial)
    changed.channels[0]!.gainDb = -6
    window.yadaw.loadMixerGraph = vi.fn().mockResolvedValue(initial)
    window.yadaw.executeProjectCommand = vi.fn()
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

  it("hides output and send targets that would create a routing cycle", () => {
    const mixer = useMixerStore()
    mixer.graph = graph()

    expect(mixer.availableOutputs("bus-b").map((channel) => channel.id))
      .toEqual(["master"])
    expect(mixer.availableSendTargets("bus-b").map((channel) => channel.id))
      .toEqual([])
  })
})

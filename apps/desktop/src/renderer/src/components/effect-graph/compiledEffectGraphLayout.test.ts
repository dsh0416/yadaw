import { describe, expect, it } from "vitest"
import type { CompiledAudioGraphSnapshot } from "@yadaw/contracts"
import { layoutCompiledEffectGraph } from "./compiledEffectGraphLayout"

const snapshot: CompiledAudioGraphSnapshot = {
  graphRevision: 7,
  buildGeneration: 11,
  sampleRate: 48_000,
  nodes: [
    {
      id: "output",
      kind: "hardware-output",
      label: "Output",
      channelId: "output",
      pluginInstanceId: null,
      signalWidth: "stereo",
      latencySamples: 0,
      pluginState: null
    },
    {
      id: "source",
      kind: "hardware-input",
      label: "Input",
      channelId: "audio",
      pluginInstanceId: null,
      signalWidth: "mono",
      latencySamples: 0,
      pluginState: null
    },
    {
      id: "adapter",
      kind: "width-adapter",
      label: "Mono → Stereo",
      channelId: "audio",
      pluginInstanceId: null,
      signalWidth: "stereo",
      latencySamples: 0,
      pluginState: null
    }
  ],
  edges: [
    {
      id: "adapter-output",
      source: "adapter",
      target: "output",
      kind: "hardware-route",
      signalWidth: "stereo"
    },
    {
      id: "source-adapter",
      source: "source",
      target: "adapter",
      kind: "signal",
      signalWidth: "mono"
    }
  ]
}

describe("layoutCompiledEffectGraph", () => {
  it("produces deterministic left-to-right positions independent of input ordering", () => {
    const first = layoutCompiledEffectGraph(snapshot)
    const second = layoutCompiledEffectGraph({
      ...snapshot,
      nodes: [...snapshot.nodes].reverse(),
      edges: [...snapshot.edges].reverse()
    })

    expect(Object.fromEntries(first.nodes.map(({ id, x, y }) => [id, { x, y }]))).toEqual(
      Object.fromEntries(second.nodes.map(({ id, x, y }) => [id, { x, y }]))
    )
    expect(first.nodes.find(({ id }) => id === "source")!.x).toBeLessThan(
      first.nodes.find(({ id }) => id === "adapter")!.x
    )
    expect(first.nodes.find(({ id }) => id === "adapter")!.x).toBeLessThan(
      first.nodes.find(({ id }) => id === "output")!.x
    )
  })
})

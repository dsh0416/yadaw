import { flushPromises, mount } from "@vue/test-utils"
import { ref } from "vue"
import { describe, expect, it, vi } from "vitest"
import type { CompiledAudioGraphSnapshot } from "@heron/contracts"
import CompiledEffectGraphChart from "./CompiledEffectGraphChart.vue"

const chartMocks = vi.hoisted(() => ({
  use: vi.fn(),
  init: vi.fn(),
  setOption: vi.fn(),
  dispose: vi.fn(),
  resize: vi.fn(),
  dispatchAction: vi.fn(),
  resizeCallback: null as null | (() => void),
  mutationCallback: null as null | (() => void)
}))

chartMocks.init.mockImplementation(() => ({
  setOption: chartMocks.setOption,
  dispose: chartMocks.dispose,
  resize: chartMocks.resize,
  dispatchAction: chartMocks.dispatchAction
}))

vi.mock("echarts/core", () => ({ init: chartMocks.init, use: chartMocks.use }))
vi.mock("echarts/charts", () => ({ GraphChart: "graph" }))
vi.mock("echarts/components", () => ({ LegendComponent: "legend", TooltipComponent: "tooltip" }))
vi.mock("echarts/renderers", () => ({ CanvasRenderer: "canvas" }))
vi.mock("@vueuse/core", () => ({
  usePreferredReducedMotion: () => ref("reduce"),
  useResizeObserver: (_target: unknown, callback: () => void) => {
    chartMocks.resizeCallback = callback
  },
  useMutationObserver: (_target: unknown, callback: () => void) => {
    chartMocks.mutationCallback = callback
  }
}))
vi.mock("./compiledEffectGraphLayout", () => ({
  layoutCompiledEffectGraph: () => ({
    nodes: [
      {
        id: "active",
        label: "Active",
        kind: "effect",
        pluginState: "active",
        latencySensitive: false,
        lowLatencyBypassed: false,
        latencySamples: 0,
        signalWidth: "stereo",
        x: 0,
        y: 0
      },
      {
        id: "bypassed",
        label: "Bypassed",
        kind: "effect",
        pluginState: "bypassed",
        latencySensitive: false,
        lowLatencyBypassed: false,
        latencySamples: 0,
        signalWidth: "stereo",
        x: 1,
        y: 0
      },
      {
        id: "unavailable",
        label: "Unavailable",
        kind: "effect",
        pluginState: "unavailable",
        latencySensitive: false,
        lowLatencyBypassed: false,
        latencySamples: 0,
        signalWidth: "mono",
        x: 2,
        y: 0
      },
      {
        id: "sensitive",
        label: "Sensitive",
        kind: "channel-input",
        pluginState: null,
        latencySensitive: true,
        lowLatencyBypassed: false,
        latencySamples: 3,
        signalWidth: "mono",
        x: 3,
        y: 0
      },
      {
        id: "pdc",
        label: "PDC",
        kind: "pdc-delay",
        pluginState: null,
        latencySensitive: false,
        lowLatencyBypassed: false,
        latencySamples: 8,
        signalWidth: "stereo",
        x: 4,
        y: 0
      },
      {
        id: "adapter",
        label: "Adapter",
        kind: "width-adapter",
        pluginState: null,
        latencySensitive: false,
        lowLatencyBypassed: false,
        latencySamples: 0,
        signalWidth: "stereo",
        x: 5,
        y: 0
      },
      {
        id: "low-latency",
        label: "Low latency",
        kind: "effect",
        pluginState: "active",
        latencySensitive: false,
        lowLatencyBypassed: true,
        latencySamples: 0,
        signalWidth: "stereo",
        x: 6,
        y: 0
      }
    ],
    edges: [
      { id: "audio", source: "active", target: "pdc", kind: "audio-route" },
      { id: "send", source: "active", target: "adapter", kind: "send-route" }
    ]
  })
}))

const snapshot: CompiledAudioGraphSnapshot = {
  graphRevision: 1,
  buildGeneration: 1,
  sampleRate: 48_000,
  nodes: [],
  edges: []
}

describe("CompiledEffectGraphChart", () => {
  it("renders every node state and reacts to resize, theme, reset, and disposal", async () => {
    document.documentElement.dataset.theme = "dark"
    document.documentElement.style.setProperty("--mixer-input", "orange")
    const wrapper = mount(CompiledEffectGraphChart, { props: { snapshot, resetToken: 0 } })
    await flushPromises()

    expect(chartMocks.use).toHaveBeenCalledOnce()
    expect(chartMocks.init).toHaveBeenCalledWith(expect.any(HTMLElement), "dark")
    const option = chartMocks.setOption.mock.calls.at(-1)![0]
    expect(option.animation).toBe(false)
    expect(option.series[0].data).toHaveLength(7)
    expect(option.series[0].data.map((node: { category: number }) => node.category)).toEqual([
      0, 3, 3, 1, 2, 1, 0
    ])
    expect(option.series[0].data[2].itemStyle.opacity).toBe(0.45)
    expect(option.series[0].data[5].symbol).toBe("diamond")
    expect(option.series[0].links[1].lineStyle).toMatchObject({ type: "dashed", curveness: 0.12 })
    expect(option.tooltip.formatter({ data: { detail: "details" } })).toBe("details")
    expect(option.tooltip.formatter({})).toBe("")

    chartMocks.resizeCallback?.()
    expect(chartMocks.resize).toHaveBeenCalledOnce()
    await wrapper.setProps({ resetToken: 1 })
    expect(chartMocks.dispatchAction).toHaveBeenCalledWith({ type: "restore" })

    chartMocks.mutationCallback?.()
    await flushPromises()
    expect(chartMocks.dispose).toHaveBeenCalled()
    expect(chartMocks.init).toHaveBeenCalledTimes(2)

    await wrapper.setProps({ snapshot: { ...snapshot, graphRevision: 2 } })
    await flushPromises()
    expect(chartMocks.init).toHaveBeenCalledTimes(3)
    wrapper.unmount()
    expect(chartMocks.dispose).toHaveBeenCalledTimes(3)
  })
})

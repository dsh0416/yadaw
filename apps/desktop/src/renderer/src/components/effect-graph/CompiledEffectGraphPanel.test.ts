import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { CompiledAudioGraphSnapshot } from "@heron/contracts"
import CompiledEffectGraphPanel from "./CompiledEffectGraphPanel.vue"

const snapshot: CompiledAudioGraphSnapshot = {
  graphRevision: 12,
  buildGeneration: 4,
  sampleRate: 48_000,
  nodes: [],
  edges: []
}

function mountPanel(
  status: "idle" | "loading" | "empty" | "ready" | "error",
  graph: CompiledAudioGraphSnapshot | null = null
) {
  return mount(CompiledEffectGraphPanel, {
    props: { status, snapshot: graph, errorMessage: "native graph failed" },
    global: {
      stubs: {
        CompiledEffectGraphChart: {
          props: ["snapshot", "resetToken"],
          template: '<div class="chart-stub">{{ resetToken }}</div>'
        }
      }
    }
  })
}

describe("CompiledEffectGraphPanel", () => {
  it.each([
    ["loading", "Reading the published audio graph"],
    ["empty", "No published graph"],
    ["error", "native graph failed"]
  ] as const)("renders the %s state", (status, message) => {
    const wrapper = mountPanel(status)
    expect(wrapper.find('[role="status"]').text()).toContain(message)
    expect(wrapper.find(".chart-stub").exists()).toBe(false)
  })

  it("emits retry from the error state", async () => {
    const wrapper = mountPanel("error")
    await wrapper.find(".graph-state button").trigger("click")
    expect(wrapper.emitted("retry")).toEqual([[]])
  })

  it("passes a reset token to the chart and increments it on demand", async () => {
    const wrapper = mountPanel("ready", snapshot)
    expect(wrapper.text()).toContain("12")
    expect(wrapper.text()).toContain("48,000")
    expect(wrapper.find(".chart-stub").text()).toBe("0")

    const reset = wrapper.find(".graph-toolbar button")
    expect(reset.attributes("disabled")).toBeUndefined()
    await reset.trigger("click")
    expect(wrapper.find(".chart-stub").text()).toBe("1")
  })

  it("disables reset while no graph is published", () => {
    const wrapper = mountPanel("idle")
    expect(wrapper.find(".graph-toolbar button").attributes("disabled")).toBeDefined()
  })
})

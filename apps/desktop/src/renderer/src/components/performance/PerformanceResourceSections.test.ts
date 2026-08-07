import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import type { SystemPerformanceSnapshot } from "@heron/contracts"
import PerformanceResourceSections from "./PerformanceResourceSections.vue"

function snapshot(): SystemPerformanceSnapshot {
  return {
    capturedAt: 1,
    cpu: {
      overallUsagePercent: 62.4,
      cores: [
        { index: 0, usagePercent: -4, speedMhz: 2_400 },
        { index: 1, usagePercent: 72.6, speedMhz: 2_500 },
        { index: 2, usagePercent: 140, speedMhz: 0 },
        { index: 3, usagePercent: null, speedMhz: 0 }
      ]
    },
    memory: {
      totalBytes: 8 * 1024 ** 3,
      usedBytes: 3 * 1024 ** 3,
      freeBytes: 5 * 1024 ** 3,
      usagePercent: 37.5
    },
    storage: [
      {
        id: "workspace",
        path: "/projects",
        state: "available",
        totalBytes: 2 * 1024 ** 4,
        freeBytes: 512 * 1024 ** 3
      },
      {
        id: "swap",
        path: null,
        state: "unconfigured",
        totalBytes: null,
        freeBytes: null
      }
    ],
    audioRuntime: null
  }
}

describe("PerformanceResourceSections", () => {
  it("renders sampled cores, memory, and storage with bounded meters", () => {
    const wrapper = mount(PerformanceResourceSections, { props: { snapshot: snapshot() } })

    const cores = wrapper.findAll(".core-channel")
    expect(cores).toHaveLength(4)
    expect(cores.map((core) => core.find(".core-value").text())).toEqual([
      "-4%",
      "73%",
      "140%",
      "—"
    ])
    expect(cores.map((core) => core.find(".core-meter").attributes("style"))).toEqual([
      "--core-level: 0%;",
      "--core-level: 72.6%;",
      "--core-level: 100%;",
      "--core-level: 0%;"
    ])
    expect(wrapper.text()).toContain("5.0 GiB")
    expect(wrapper.text()).toContain("25% free")
    expect(wrapper.text()).toContain("512.0 GiB available")
    expect(wrapper.text()).toContain("unconfigured")
  })

  it("shows placeholders when a sample has not arrived", () => {
    const wrapper = mount(PerformanceResourceSections, { props: { snapshot: null } })

    expect(wrapper.find(".monitor-placeholder").exists()).toBe(true)
    expect(wrapper.findAll(".core-channel")).toHaveLength(0)
    expect(wrapper.findAll(".storage-space")).toHaveLength(2)
    expect(wrapper.text()).toContain("—")
  })
})

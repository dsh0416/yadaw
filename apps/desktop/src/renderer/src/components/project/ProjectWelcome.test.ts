import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import ProjectWelcome from "./ProjectWelcome.vue"

describe("ProjectWelcome", () => {
  it("creates a project with the locked defaults", async () => {
    const wrapper = mount(ProjectWelcome, { props: { settings: null, busy: false, error: "" } })
    await wrapper.get("button").trigger("click")
    expect(wrapper.emitted("create")?.[0]?.[0]).toEqual({
      name: "Untitled project",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })
    expect(wrapper.find("input").exists()).toBe(false)
  })

  it("opens a recent project through its public button", async () => {
    const wrapper = mount(ProjectWelcome, {
      props: {
        settings: {
          swapDirectory: "swap",
          recordingBitDepth: "float32",
          theme: "system",
          locale: "en-US",
          meterPeakHold: "800ms",
          meterReturnRate: "iec-type-i",
          midiCenterCStandard: "roland-c4",
          softwareMonitoringEnabled: false,
          midiSync: {
            enabled: false,
            sourcePortId: null,
            sourcePortName: null,
            inputOffsetsMs: {}
          },
          audioHostRuntime: {
            workerThreads: "auto",
            maxBlockingThreads: "auto",
            egressConcurrency: "auto"
          },
          pluginEditors: {},
          shortcuts: { keyboard: {}, midi: {} },
          recentProjects: [{ path: "C:/song.yadaw", name: "Song", openedAt: 1 }]
        },
        busy: false,
        error: ""
      }
    })
    await wrapper.findAll(".recent-item")[0]?.trigger("click")
    expect(wrapper.emitted("open")?.[0]).toEqual(["C:/song.yadaw"])
  })
})

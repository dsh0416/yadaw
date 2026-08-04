import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import ProjectWelcome from "./ProjectWelcome.vue"

describe("ProjectWelcome", () => {
  it("creates a project with the locked defaults", async () => {
    const wrapper = mount(ProjectWelcome, { props: { settings: null, busy: false, error: "" } })
    await wrapper.get(".project-welcome__create").trigger("click")
    expect(wrapper.emitted("create")?.[0]?.[0]).toEqual({
      name: "Untitled project",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })
    expect(wrapper.find("input").exists()).toBe(false)
  })

  it("introduces the creative task without exposing implementation details", () => {
    const wrapper = mount(ProjectWelcome, { props: { settings: null, busy: false, error: "" } })
    const copy = wrapper.text().replace(/\s+/g, " ")

    expect(copy).toContain("From sketch to stage.")
    expect(copy).toContain("Make sound your own.")
    expect(copy).toContain("A free, open-source workspace")
    expect(copy).toContain("Start creating")
    expect(copy).not.toMatch(/PGlite|swap|archive|48 kHz/i)
  })

  it("keeps the waveform motion focused without the extra signature mark", () => {
    const wrapper = mount(ProjectWelcome, { props: { settings: null, busy: false, error: "" } })

    expect(wrapper.find(".project-welcome__signature").exists()).toBe(false)
    expect(wrapper.get(".project-welcome__waveform--motion").attributes("filter")).toBe(
      "url(#welcome-wave-shadow-motion)"
    )
    expect(wrapper.findAll("feTurbulence animate")).toHaveLength(2)
    expect(wrapper.get('feDisplacementMap animate[attributeName="scale"]').attributes("dur")).toBe(
      "2s"
    )
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
            maxBlockingThreads: "auto"
          },
          pluginEditors: {},
          shortcuts: { keyboard: {}, midi: {} },
          recentProjects: [{ path: "C:/song.heron", name: "Song", openedAt: 1 }]
        },
        busy: false,
        error: ""
      }
    })
    await wrapper.findAll(".recent-item")[0]?.trigger("click")
    expect(wrapper.emitted("open")?.[0]).toEqual(["C:/song.heron"])
  })
})

import { mount } from "@vue/test-utils"
import { createPinia } from "pinia"
import { describe, expect, it } from "vitest"
import StudioTopbar from "./StudioTopbar.vue"

const tempoMap = {
  ticksPerQuarter: 960 as const,
  tempoEvents: [
    { tick: 0, beatsPerMinute: 120 },
    { tick: 3_840, beatsPerMinute: 60 }
  ],
  timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
}

const masterChannel = {
  id: "master",
  kind: "master" as const,
  systemRole: null,
  name: "Master",
  color: "#67D9E7",
  sortOrder: 0,
  inputSource: null,
  inputFormat: null,
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [],
  hardwareOutputChannels: []
}
const metronomeChannel = {
  id: "metronome",
  kind: "instrument" as const,
  systemRole: "metronome" as const,
  name: "Metronome",
  color: "#AD8CFF",
  sortOrder: 0,
  inputSource: null,
  inputFormat: null,
  gainDb: 0,
  pan: 0,
  muted: true,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [],
  hardwareOutputChannels: []
}
const masterMeter = {
  channelId: "master",
  preFaderPeak: [0, 0] as [number, number],
  postFaderPeak: [0.25, 0.5] as [number, number],
  heldPeak: [0.25, 0.5] as [number, number],
  clipped: false
}

function mountTopbar() {
  return mount(StudioTopbar, {
    props: {
      engineRunning: false,
      recording: false,
      recordingBusy: false,
      playing: false,
      playLoading: false,
      canPlay: true,
      playheadSeconds: 3,
      tempoMap,
      soundBrowserOpen: true,
      mixerDockOpen: true,
      metronomeChannel,
      masterChannel,
      masterMeter
    },
    global: {
      plugins: [createPinia()],
      stubs: {
        TooltipRoot: { template: "<div><slot /></div>" },
        TooltipTrigger: {
          props: {
            asChild: Boolean
          },
          template: "<slot />"
        },
        TooltipPortal: true,
        TooltipContent: true,
        TooltipArrow: true
      }
    }
  })
}

describe("StudioTopbar", () => {
  it("renders the Logic-style groups in order and exposes only real actions", async () => {
    const wrapper = mountTopbar()

    expect(
      wrapper.findAll("[data-topbar-group]").map((group) => group.attributes("data-topbar-group"))
    ).toEqual([
      "left-panel",
      "bottom-panel",
      "transport",
      "musical-display",
      "tools",
      "metronome",
      "master",
      "right-panel"
    ])

    expect(wrapper.get('button[aria-label="Library"]').attributes("aria-pressed")).toBe("true")
    expect(wrapper.get('button[aria-label="Mixer"]').attributes("aria-pressed")).toBe("true")
    await wrapper.get('button[aria-label="Library"]').trigger("click")
    await wrapper.get('button[aria-label="Mixer"]').trigger("click")
    await wrapper.get('button[aria-label="Go to beginning"]').trigger("click")
    await wrapper.get('button[aria-label="Play"]').trigger("click")
    await wrapper.get('button[aria-label="Metronome"]').trigger("click")

    expect(wrapper.emitted("toggleSoundBrowser")).toHaveLength(1)
    expect(wrapper.emitted("toggleMixerDock")).toHaveLength(1)
    expect(wrapper.emitted("goToStart")).toHaveLength(1)
    expect(wrapper.emitted("togglePlayback")).toHaveLength(1)
    expect(wrapper.emitted("toggleMetronome")).toHaveLength(1)

    const placeholders = wrapper.findAll('button[aria-disabled="true"][data-placeholder]')
    expect(placeholders.length).toBeGreaterThan(10)
    expect(wrapper.get('button[aria-label="Metronome"]').attributes("aria-pressed")).toBe("false")
  })

  it("reflects Mixer mute state and disables the control if the system channel is missing", async () => {
    const wrapper = mountTopbar()
    await wrapper.setProps({
      metronomeChannel: { ...metronomeChannel, muted: false }
    })
    expect(wrapper.get('button[aria-label="Metronome"]').attributes("aria-pressed")).toBe("true")

    await wrapper.setProps({ metronomeChannel: null })
    const button = wrapper.get('button[aria-label="Metronome"]')
    expect(button.attributes("aria-disabled")).toBe("true")
    await button.trigger("click")
    expect(wrapper.emitted("toggleMetronome")).toBeUndefined()
  })

  it("edits the current Tempo Track value on double-click", async () => {
    const wrapper = mountTopbar()

    await wrapper.get('button[aria-label^="Tempo 60.00 BPM"]').trigger("dblclick")
    const input = wrapper.get('input[aria-label="Edit current tempo"]')
    await input.setValue("72.5")
    await input.trigger("keydown", { key: "Enter" })

    expect(wrapper.emitted("updateTempo")).toEqual([[72.5]])
    expect(wrapper.find('input[aria-label="Edit current tempo"]').exists()).toBe(false)
  })

  it("clamps edited tempo to the supported range", async () => {
    const wrapper = mountTopbar()

    await wrapper.get('button[aria-label^="Tempo 60.00 BPM"]').trigger("dblclick")
    const input = wrapper.get('input[aria-label="Edit current tempo"]')
    await input.setValue("500")
    await input.trigger("keydown", { key: "Enter" })

    expect(wrapper.emitted("updateTempo")).toEqual([[300]])
  })

  it("cancels the edit without changing tempo", async () => {
    const wrapper = mountTopbar()

    await wrapper.get('button[aria-label^="Tempo 60.00 BPM"]').trigger("dblclick")
    const input = wrapper.get('input[aria-label="Edit current tempo"]')
    await input.setValue("90")
    await input.trigger("keydown", { key: "Escape" })

    expect(wrapper.emitted("updateTempo")).toBeUndefined()
  })
})

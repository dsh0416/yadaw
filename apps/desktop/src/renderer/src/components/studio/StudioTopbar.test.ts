import { mount } from "@vue/test-utils"
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

function mountTopbar() {
  return mount(StudioTopbar, {
    props: {
      engineRunning: false,
      project: {
        name: "Session",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      recording: false,
      recordingBusy: false,
      dirty: false,
      playing: false,
      playLoading: false,
      canPlay: true,
      playheadSeconds: 3,
      tempoMap
    },
    global: {
      stubs: {
        TooltipRoot: { template: "<div><slot /></div>" },
        TooltipTrigger: { template: "<slot />" },
        TooltipPortal: true,
        TooltipContent: true,
        TooltipArrow: true
      }
    }
  })
}

describe("StudioTopbar", () => {
  it("edits the current Tempo Track value on double-click", async () => {
    const wrapper = mountTopbar()

    await wrapper.get('button[aria-label^="Tempo 60.00 BPM"]').trigger("dblclick")
    const input = wrapper.get('input[aria-label="Edit current tempo"]')
    await input.setValue("72.5")
    await input.trigger("keydown", { key: "Enter" })

    expect(wrapper.emitted("updateTempo")).toEqual([[72.5]])
    expect(wrapper.find('input[aria-label="Edit current tempo"]').exists()).toBe(false)
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

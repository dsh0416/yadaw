import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { MixerChannelState, PluginDescriptor } from "@yadaw/contracts"
import { useMixerStore } from "../../stores/mixer"
import MixerConsole from "./MixerConsole.vue"

const descriptor: PluginDescriptor = {
  classId: "effect",
  modulePath: "effect.vst3",
  name: "Effect",
  vendor: "YADAW",
  version: "1.0",
  category: "Fx",
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

function channel(id: string, kind: MixerChannelState["kind"]): MixerChannelState {
  return {
    id,
    kind,
    name: id,
    color: "#4F8CFF",
    sortOrder: 0,
    inputFormat: kind === "audio" ? "stereo" : null,
    gainDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
    outputChannelId: ["audio", "bus"].includes(kind) ? "output" : null,
    recordArmed: false,
    inputChannels: kind === "audio" ? [1, 2] : [],
    hardwareOutputChannels: kind === "output" ? [1, 2] : []
  }
}

describe("MixerConsole", () => {
  it("uses shared plugin/send row heights and one scrolling console", () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixerStore = useMixerStore()
    mixerStore.graph = {
      sampleRate: 48_000,
      channels: [
        channel("audio", "audio"),
        channel("bus-a", "bus"),
        channel("bus-b", "bus"),
        channel("bus-c", "bus"),
        channel("master", "master"),
        channel("output", "output")
      ],
      clips: [],
      sends: ["bus-a", "bus-b", "bus-c"].map((targetChannelId, index) => ({
        id: `send-${index}`,
        sourceChannelId: "audio",
        targetChannelId,
        sortOrder: index,
        enabled: true,
        tap: "post-pan" as const,
        levelDb: -12,
        pan: 0
      })),
      plugins: Array.from({ length: 5 }, (_, index) => ({
        id: `plugin-${index}`,
        channelId: "audio",
        role: "insert" as const,
        slotOrder: index,
        classId: descriptor.classId,
        descriptor,
        enabled: true,
        componentState: new Uint8Array(),
        controllerState: new Uint8Array()
      })),
      midiClips: [],
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      }
    }

    const wrapper = mount(MixerConsole, { global: { plugins: [pinia] } })
    const scroller = wrapper.get(".channel-scroll")
    expect(scroller.attributes("style")).toContain("--plugin-section-height: 132px")
    expect(scroller.attributes("style")).toContain("--send-section-height: 117px")
    expect(wrapper.find(".mixer-section-labels").exists()).toBe(true)
    expect(wrapper.findAll(".channel-strip")).toHaveLength(6)
    expect(wrapper.find(".channel-strip.master").classes()).toContain("master")
  })
})

import { nextTick } from "vue"
import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { MixerChannelState, PluginDescriptor } from "@heron/contracts"
import { useMixerStore } from "../../stores/mixer"
import MixerConsole from "./MixerConsole.vue"

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  locator: { format: "vst3", artifactPath: "effect.vst3", nativeId: "effect" },
  name: "Effect",
  vendor: "Heron Studio",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["mono", "mono-to-stereo", "stereo", "dual-mono"],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

function channel(id: string, kind: MixerChannelState["kind"]): MixerChannelState {
  return {
    id,
    kind,
    systemRole: null,
    name: id,
    color: "#4F8CFF",
    sortOrder: 0,
    inputSource: kind === "audio" ? "hardware" : kind === "aux" ? "bus" : null,
    inputFormat: kind === "audio" || kind === "aux" ? "stereo" : null,
    gainDb: 0,
    pan: 0,
    muted: false,
    soloed: false,
    outputChannelId: ["audio", "instrument", "aux"].includes(kind) ? "output" : null,
    recordArmed: false,
    inputMonitoring: false,
    inputChannels: kind === "audio" || kind === "aux" ? [1, 2] : [],
    hardwareOutputChannels: kind === "output" ? [1, 2] : []
  }
}

describe("MixerConsole", () => {
  it("keeps one trailing plugin/send slot and grows shared heights with new entries", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixerStore = useMixerStore()
    mixerStore.graph = {
      sampleRate: 48_000,
      tracks: [{ id: "track:audio", channelId: "audio", sortOrder: 0 }],
      channels: [
        channel("audio", "audio"),
        channel("aux-a", "aux"),
        channel("aux-b", "aux"),
        channel("aux-c", "aux"),
        channel("master", "master"),
        channel("output", "output")
      ],
      audioClips: [],
      sends: [1, 2, 3].map((targetBus, index) => ({
        id: `send-${index}`,
        sourceChannelId: "audio",
        targetBus,
        sortOrder: index,
        enabled: true,
        tap: "post-pan" as const,
        levelDb: -12
      })),
      plugins: Array.from({ length: 5 }, (_, index) => ({
        id: `plugin-${index}`,
        channelId: "audio",
        role: "insert" as const,
        slotOrder: index,
        locator: descriptor.locator,
        descriptor,
        audioMode: "stereo",
        enabled: true,
        sidechainInputs: [],
        state: { version: 1, chunks: [] }
      })),
      midiClips: [],
      keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
        timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
      }
    }

    const wrapper = mount(MixerConsole, { global: { plugins: [pinia] } })
    const scroller = wrapper.get(".channel-scroll")
    expect(scroller.attributes("style")).toContain("--plugin-section-height: 156px")
    expect(scroller.attributes("style")).toContain("--send-section-height: 116px")
    expect(wrapper.find(".mixer-section-labels").exists()).toBe(true)
    expect(wrapper.findAll(".channel-strip")).toHaveLength(6)
    expect(wrapper.find(".channel-strip.master").classes()).toContain("master")

    mixerStore.graph = {
      ...mixerStore.graph,
      plugins: [
        ...mixerStore.graph.plugins,
        {
          id: "plugin-5",
          channelId: "audio",
          role: "insert",
          slotOrder: 5,
          locator: descriptor.locator,
          descriptor,
          audioMode: "stereo",
          enabled: true,
          sidechainInputs: [],
          state: { version: 1, chunks: [] }
        }
      ],
      sends: [
        ...mixerStore.graph.sends,
        {
          id: "send-3",
          sourceChannelId: "audio",
          targetBus: 4,
          sortOrder: 3,
          enabled: true,
          tap: "post-pan",
          levelDb: -12
        }
      ]
    }
    await nextTick()

    expect(scroller.attributes("style")).toContain("--plugin-section-height: 180px")
    expect(scroller.attributes("style")).toContain("--send-section-height: 142px")
  })
})

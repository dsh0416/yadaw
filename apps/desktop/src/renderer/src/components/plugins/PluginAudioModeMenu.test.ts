import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { PluginDescriptor } from "@heron/contracts"
import PluginAudioModeMenu from "./PluginAudioModeMenu.vue"

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "mono-effect",
  modulePath: "mono-effect.vst3",
  name: "Mono Effect",
  vendor: "YADAW",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["mono", "dual-mono"],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

describe("PluginAudioModeMenu", () => {
  it("shows every applicable mode, disables unsupported modes, and emits only a confirmed mode", async () => {
    const wrapper = mount(PluginAudioModeMenu, {
      attachTo: document.body,
      props: { descriptor, inputWidth: "mono" }
    })
    expect(wrapper.findAll(".mode-list > button")).toHaveLength(2)
    expect(wrapper.find('button[title^="Stereo"]').exists()).toBe(false)
    expect(wrapper.find('button[title^="Dual mono"]').exists()).toBe(false)

    expect(
      wrapper.get('button[title="Mono to stereo is not supported by this plug-in"]').attributes()
    ).toHaveProperty("disabled")
    expect(wrapper.emitted("select")).toBeUndefined()

    const mono = wrapper.get('button[title="Mono: 1 → 1"]')
    expect(document.activeElement).toBe(mono.element)
    await mono.trigger("click")
    expect(wrapper.emitted("select")?.at(-1)).toEqual(["mono"])

    await wrapper.setProps({ inputWidth: "stereo" })
    expect(wrapper.findAll(".mode-list > button")).toHaveLength(2)
    expect(wrapper.find('button[title^="Mono:"]').exists()).toBe(false)
    expect(wrapper.find('button[title^="Mono to stereo"]').exists()).toBe(false)
    const dualMono = wrapper.get('button[title="Dual mono: 2 × (1 → 1)"]')
    expect(document.activeElement).toBe(dualMono.element)

    await wrapper.get('button[aria-label="Back to plugin list"]').trigger("click")
    expect(wrapper.emitted("cancel")?.at(-1)).toEqual([])
    wrapper.unmount()
  })
})

import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import type { MixerChannelState, PluginDescriptor, PluginInstanceState } from "@yadaw/contracts"
import { PLUGIN_DRAG_TYPE } from "../plugins/plugin-drag"
import MixerPluginSection from "./MixerPluginSection.vue"

const channel: MixerChannelState = {
  id: "audio",
  kind: "audio",
  name: "Vocal",
  color: "#4F8CFF",
  sortOrder: 0,
  inputFormat: "mono",
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: "output",
  recordArmed: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

const descriptor: PluginDescriptor = {
  classId: "compressor",
  modulePath: "compressor.vst3",
  name: "Compressor",
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

const plugin: PluginInstanceState = {
  id: "plugin",
  channelId: "audio",
  role: "insert",
  slotOrder: 0,
  classId: descriptor.classId,
  descriptor,
  enabled: true,
  componentState: new Uint8Array(),
  controllerState: new Uint8Array()
}

describe("MixerPluginSection", () => {
  it("offers compact open, bypass, remove, and catalog drop actions", async () => {
    const wrapper = mount(MixerPluginSection, {
      props: {
        channel,
        instrument: null,
        inserts: [plugin],
        runtime: {},
        slotRows: 4
      }
    })

    await wrapper.get('button[aria-label="Open Compressor editor"]').trigger("click")
    expect(wrapper.emitted("open")?.at(-1)).toEqual(["plugin"])
    await wrapper.get('button[aria-label="Bypass Compressor"]').trigger("click")
    expect(wrapper.emitted("toggle")?.at(-1)).toEqual(["plugin", false])
    await wrapper.get('button[aria-label="Remove Compressor"]').trigger("click")
    expect(wrapper.emitted("remove")?.at(-1)).toEqual(["plugin"])
    expect(wrapper.findAll(".plugin-row.empty")).toHaveLength(1)
    expect(wrapper.findAll(".plugin-row.alignment-spacer")).toHaveLength(2)

    const nextDescriptor = { ...descriptor, classId: "delay", name: "Delay" }
    await wrapper.find(".plugin-row.empty").trigger("drop", {
      dataTransfer: {
        types: [PLUGIN_DRAG_TYPE],
        getData: () =>
          JSON.stringify({
            source: "catalog",
            descriptor: nextDescriptor
          })
      }
    })
    expect(wrapper.emitted("insert")?.at(-1)).toEqual([nextDescriptor, 1])
  })
})

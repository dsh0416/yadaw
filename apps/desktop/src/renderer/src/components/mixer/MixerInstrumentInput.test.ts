import { afterEach, describe, expect, it } from "vitest"
import { DOMWrapper, flushPromises, mount } from "@vue/test-utils"
import type { PluginDescriptor, PluginInstanceState } from "@yadaw/contracts"
import { PLUGIN_DRAG_TYPE } from "../plugins/plugin-drag"
import MixerInstrumentInput from "./MixerInstrumentInput.vue"

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "synth",
  modulePath: "synth.vst3",
  name: "Synth",
  vendor: "YADAW",
  version: "1.0",
  category: "Instrument",
  kind: "instrument",
  architecture: "x86_64",
  buses: [],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

const instrument: PluginInstanceState = {
  id: "instrument-plugin",
  channelId: "instrument",
  role: "instrument",
  slotOrder: 0,
  classId: descriptor.classId,
  descriptor,
  enabled: true,
  componentState: new Uint8Array(),
  controllerState: new Uint8Array()
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("MixerInstrumentInput", () => {
  it("renders the assigned instrument as the channel input", async () => {
    const wrapper = mount(MixerInstrumentInput, {
      props: {
        instrument,
        runtime: {},
        plugins: [descriptor]
      }
    })

    expect(wrapper.text()).toContain("Synth")
    expect(wrapper.text()).not.toContain("MIDI")
    await wrapper.get('button[aria-label="Open Synth instrument editor"]').trigger("click")
    expect(wrapper.emitted("open")?.at(-1)).toEqual(["instrument-plugin"])
    expect(wrapper.find('button[aria-label="Bypass Synth"]').exists()).toBe(false)
    await wrapper.get('button[aria-label="Remove Synth"]').trigger("click")
    expect(wrapper.emitted("remove")?.at(-1)).toEqual(["instrument-plugin"])
  })

  it("assigns an instrument from the empty input picker or a catalog drop", async () => {
    const wrapper = mount(MixerInstrumentInput, {
      attachTo: document.body,
      props: {
        instrument: null,
        runtime: {},
        plugins: [descriptor]
      }
    })

    await wrapper.get('button[aria-label="Assign VST3 instrument input"]').trigger("click")
    await flushPromises()
    const synthButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Add Synth"]'
    )
    expect(synthButton).not.toBeNull()
    await new DOMWrapper(synthButton).trigger("click")
    expect(wrapper.emitted("assign")?.at(-1)).toEqual([descriptor])

    await wrapper.get('button[aria-label="Assign VST3 instrument input"]').trigger("drop", {
      dataTransfer: {
        types: [PLUGIN_DRAG_TYPE],
        getData: () =>
          JSON.stringify({
            source: "catalog",
            descriptor
          })
      }
    })
    expect(wrapper.emitted("assign")?.at(-1)).toEqual([descriptor])
  })
})

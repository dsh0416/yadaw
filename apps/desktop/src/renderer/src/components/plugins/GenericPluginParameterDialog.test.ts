import { afterEach, describe, expect, it } from "vitest"
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import type { PluginDescriptor } from "@yadaw/contracts"
import { useMixerStore } from "../../stores/mixer"
import { usePluginStore } from "../../stores/plugins"
import GenericPluginParameterDialog from "./GenericPluginParameterDialog.vue"

const descriptor: PluginDescriptor = {
  classId: "generic",
  modulePath: "generic.vst3",
  name: "Generic Effect",
  vendor: "YADAW",
  version: "1.0",
  category: "Fx",
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  hasEditor: false,
  compatibility: "compatible",
  compatibilityReason: null
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("GenericPluginParameterDialog", () => {
  it("hosts generic parameters outside the removed channel inspector", async () => {
    const pinia = createPinia()
    setActivePinia(pinia)
    const mixerStore = useMixerStore()
    mixerStore.graph = {
      ...mixerStore.graph,
      plugins: [
        {
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
      ]
    }
    const pluginStore = usePluginStore()
    pluginStore.parameters = {
      plugin: [
        {
          id: 1,
          title: "Mix",
          shortTitle: "Mix",
          units: "%",
          stepCount: 0,
          defaultNormalized: 0.5,
          normalized: 0.75,
          flags: 0
        }
      ]
    }
    pluginStore.genericPanelId = "plugin"

    mount(GenericPluginParameterDialog, {
      attachTo: document.body,
      global: { plugins: [pinia] }
    })
    await flushPromises()

    expect(document.body.textContent).toContain("Generic Effect")
    expect(document.body.querySelector('input[aria-label="Mix"]')).not.toBeNull()
    document.body
      .querySelector<HTMLButtonElement>('button[aria-label="Close generic parameter panel"]')
      ?.click()
    await flushPromises()
    expect(pluginStore.genericPanelId).toBeNull()
  })
})

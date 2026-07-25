import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { usePluginStore } from "./plugins"

describe("plugin store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it("opens the generic parameter panel when a native editor is unavailable", async () => {
    window.yadaw.openPluginEditor = vi.fn().mockResolvedValue({
      instanceId: "plugin-1",
      state: "active",
      editorOpen: false,
      latencySamples: 64,
      tailSamples: 0,
      error: null
    })
    window.yadaw.getPluginParameters = vi.fn().mockResolvedValue([{
      id: 7,
      title: "Mix",
      shortTitle: "Mix",
      units: "%",
      stepCount: 0,
      defaultNormalized: 1,
      normalized: 0.5,
      flags: 0
    }])
    const store = usePluginStore()

    await store.openEditor("plugin-1")

    expect(store.genericPanelId).toBe("plugin-1")
    expect(store.parameters["plugin-1"]?.[0]).toMatchObject({
      id: 7,
      normalized: 0.5
    })
  })

  it("updates parameter feedback while preserving gesture boundaries", async () => {
    window.yadaw.setPluginParameter = vi.fn().mockResolvedValue(undefined)
    const store = usePluginStore()
    store.parameters = {
      "plugin-1": [{
        id: 7,
        title: "Mix",
        shortTitle: "Mix",
        units: "%",
        stepCount: 0,
        defaultNormalized: 1,
        normalized: 0.5,
        flags: 0
      }]
    }

    await store.setParameter({
      instanceId: "plugin-1",
      parameterId: 7,
      normalized: 0.75,
      gesture: "perform"
    })

    expect(store.parameters["plugin-1"]?.[0]?.normalized).toBe(0.75)
    expect(window.yadaw.setPluginParameter).toHaveBeenCalledWith({
      instanceId: "plugin-1",
      parameterId: 7,
      normalized: 0.75,
      gesture: "perform"
    })
  })
})

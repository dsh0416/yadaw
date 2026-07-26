import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { MixerGraphSnapshot, PluginDescriptor } from "@yadaw/contracts"
import { useMixerStore } from "./mixer"
import { usePluginStore } from "./plugins"

const effectDescriptor: PluginDescriptor = {
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

const instrumentDescriptor: PluginDescriptor = {
  ...effectDescriptor,
  classId: "instrument",
  modulePath: "instrument.vst3",
  name: "Instrument",
  category: "Instrument",
  kind: "instrument"
}

function graph(): MixerGraphSnapshot {
  return {
    sampleRate: 48_000,
    channels: [
      {
        id: "audio",
        kind: "audio",
        name: "Audio",
        color: "#4F8CFF",
        sortOrder: 0,
        inputFormat: "stereo",
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputChannels: [1, 2],
        hardwareOutputChannels: []
      },
      {
        id: "instrument",
        kind: "instrument",
        name: "Instrument",
        color: "#9B7CF6",
        sortOrder: 0,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: "output",
        recordArmed: false,
        inputChannels: [],
        hardwareOutputChannels: []
      },
      {
        id: "output",
        kind: "output",
        name: "Output",
        color: "#EF7C95",
        sortOrder: 0,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        recordArmed: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ],
    clips: [],
    sends: [],
    plugins: [],
    midiClips: [],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
  }
}

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
    window.yadaw.getPluginParameters = vi.fn().mockResolvedValue([
      {
        id: 7,
        title: "Mix",
        shortTitle: "Mix",
        units: "%",
        stepCount: 0,
        defaultNormalized: 1,
        normalized: 0.5,
        flags: 0
      }
    ])
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
      "plugin-1": [
        {
          id: 7,
          title: "Mix",
          shortTitle: "Mix",
          units: "%",
          stepCount: 0,
          defaultNormalized: 1,
          normalized: 0.5,
          flags: 0
        }
      ]
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

  it("adds selected effects and instruments through project commands", async () => {
    const mixerStore = useMixerStore()
    mixerStore.graph = graph()
    window.yadaw.executeProjectCommand = vi.fn().mockImplementation(async (command) => {
      if (command.type !== "create-plugin") throw new Error("Unexpected project command")
      const next = structuredClone(mixerStore.graph)
      next.plugins.push(structuredClone(command.plugin))
      return {
        graph: next,
        inverse: { type: "delete-plugin" as const, pluginId: command.plugin.id }
      }
    })
    const pluginStore = usePluginStore()

    expect(await pluginStore.addEffectAt(effectDescriptor, "audio", 0)).toBe(true)
    expect(await pluginStore.assignInstrument(instrumentDescriptor, "instrument")).toBe(true)

    const commands = vi
      .mocked(window.yadaw.executeProjectCommand)
      .mock.calls.map(([command]) => command)
    expect(commands[0]).toMatchObject({
      type: "create-plugin",
      plugin: {
        channelId: "audio",
        role: "insert",
        slotOrder: 0,
        descriptor: effectDescriptor
      }
    })
    expect(commands[1]).toMatchObject({
      type: "create-plugin",
      plugin: {
        channelId: "instrument",
        role: "instrument",
        slotOrder: 0,
        descriptor: instrumentDescriptor
      }
    })
    expect(mixerStore.graph.plugins).toHaveLength(2)
  })
})

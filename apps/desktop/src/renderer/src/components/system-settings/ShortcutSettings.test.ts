import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApplicationSettings, MidiInputSnapshot, ShortcutPreferences } from "@yadaw/contracts"
import ShortcutSettings from "./ShortcutSettings.vue"
import { useApplicationSettingsStore } from "../../stores/applicationSettings"

import { useAudioRuntimeStore } from "../../stores/audioRuntime"
import { rpcEvent } from "../../test/ipc"
const EMPTY_MIDI_SNAPSHOT: MidiInputSnapshot = {
  ports: [{ id: "controller", name: "Studio Controller", connected: true }],
  sync: {
    state: "internal",
    sourcePortId: null,
    sourcePortName: null,
    effectiveBpm: null,
    jitterMicroseconds: null,
    lastClockAgeMs: null,
    droppedEvents: 0,
    ignoredSystemMessages: 0,
    error: null
  },
  controlEvents: [],
  capturedAt: 1
}

function applicationSettings(shortcuts: ShortcutPreferences): ApplicationSettings {
  return {
    swapDirectory: "C:/swap",
    recordingBitDepth: "float32",
    theme: "system",
    locale: "en-US",
    meterPeakHold: "800ms",
    meterReturnRate: "iec-type-i",
    midiCenterCStandard: "roland-c4",
    softwareMonitoringEnabled: false,
    midiSync: {
      enabled: false,
      sourcePortId: null,
      sourcePortName: null,
      inputOffsetsMs: {}
    },
    audioHostRuntime: {
      workerThreads: "auto",
      maxBlockingThreads: "auto",
      egressConcurrency: "auto"
    },
    pluginEditors: {},
    shortcuts,
    recentProjects: []
  }
}
const host = {
  kind: "audio-host" as const,
  id: "audio-host",
  epoch: "helper-epoch",
  generation: 1
}

const midiRuntime = {
  kind: "midi-runtime" as const,
  id: "midi-runtime",
  epoch: "helper-epoch",
  generation: 1
}

function midiResource(snapshot: MidiInputSnapshot) {
  return {
    runtime: midiRuntime,
    host,
    revision: 1,
    snapshot: structuredClone(snapshot)
  }
}

function midiSuccess(snapshot: MidiInputSnapshot) {
  return {
    ok: true as const,
    requestId: "midi-request",
    value: midiResource(snapshot),
    warnings: []
  }
}

function commandRow(wrapper: ReturnType<typeof mount>, command: string) {
  return wrapper.findAll(".shortcut-row").find((row) => row.text().includes(command))!
}

describe("ShortcutSettings", () => {
  let publishMidi: ((snapshot: MidiInputSnapshot) => void) | null

  beforeEach(() => {
    publishMidi = null
    Object.defineProperty(window.yadaw, "platform", {
      configurable: true,
      value: "win32"
    })
  })

  function mountSettings(shortcuts: ShortcutPreferences = { keyboard: {}, midi: {} }) {
    const pinia = createPinia()
    setActivePinia(pinia)
    const settingsStore = useApplicationSettingsStore()
    settingsStore.settings = applicationSettings(shortcuts)
    settingsStore.resource = {
      kind: "application-settings",
      id: "settings",
      epoch: "main-epoch",
      generation: 1
    }
    settingsStore.revision = 1
    useAudioRuntimeStore().applyResources({
      host,
      engine: null,
      transport: null,
      midiRuntime,
      revision: 0
    })
    window.yadaw.midiInputSnapshot = vi.fn().mockResolvedValue(midiSuccess(EMPTY_MIDI_SNAPSHOT))
    window.yadaw.subscribeMidiInput = vi.fn((listener) => {
      publishMidi = (snapshot) =>
        listener(rpcEvent(midiResource(snapshot), snapshot.capturedAt, host.epoch))
      return () => undefined
    })
    window.yadaw.setMidiControlLearning = vi.fn(async (_meta, enabled) => {
      return midiSuccess({
        ...EMPTY_MIDI_SNAPSHOT,
        capturedAt: enabled ? 2 : 3
      })
    })
    window.yadaw.configureShortcuts = vi.fn(async (_meta, next) => ({
      ok: true as const,
      requestId: "settings-shortcuts",
      resourceRevision: 2,
      value: {
        settings: settingsStore.resource!,
        revision: 2,
        value: applicationSettings(next)
      },
      warnings: []
    }))
    const wrapper = mount(ShortcutSettings, {
      global: {
        plugins: [pinia],
        stubs: {
          SettingsPage: { template: "<main><slot /></main>" },
          SettingsSection: { template: "<section><slot /></section>" }
        }
      }
    })
    return { settingsStore, wrapper }
  }

  it("captures, replaces, cancels, and clears keyboard bindings", async () => {
    const { settingsStore, wrapper } = mountSettings()
    await flushPromises()
    const saveRow = commandRow(wrapper, "project.save")
    const keyboardButton = saveRow.findAll(".binding-button")[0]!

    await keyboardButton.trigger("click")
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        code: "KeyO",
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
    await flushPromises()

    expect(settingsStore.settings?.shortcuts.keyboard).toMatchObject({
      "project.open": null,
      "project.save": { code: "KeyO", modifiers: ["primary"] }
    })

    await keyboardButton.trigger("click")
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "ControlLeft", ctrlKey: true }))
    expect(keyboardButton.text()).toContain("Press keys")
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape" }))
    await flushPromises()
    expect(keyboardButton.text()).not.toContain("Press keys")

    await keyboardButton.trigger("click")
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Delete" }))
    await flushPromises()
    expect(settingsStore.settings?.shortcuts.keyboard["project.save"]).toBeNull()
  })

  it("learns, labels, clears, and resets MIDI bindings", async () => {
    const { settingsStore, wrapper } = mountSettings({
      keyboard: {},
      midi: {
        "project.open": {
          portId: "controller",
          portName: "Studio Controller",
          channel: 1,
          type: "note",
          number: 40
        }
      }
    })
    await flushPromises()
    expect(commandRow(wrapper, "project.open").text()).toContain("Note 40")

    const saveRow = commandRow(wrapper, "project.save")
    await saveRow.findAll(".binding-button")[1]!.trigger("click")
    await flushPromises()
    expect(window.yadaw.setMidiControlLearning).toHaveBeenCalledWith(expect.any(Object), true)

    publishMidi?.({
      ...EMPTY_MIDI_SNAPSHOT,
      controlEvents: [
        {
          generation: 1,
          timestampMicroseconds: 100,
          portId: "controller",
          portName: "Studio Controller",
          channel: 1,
          type: "control-change",
          number: 64,
          value: 127
        }
      ]
    })
    await flushPromises()

    expect(settingsStore.settings?.shortcuts.midi["project.save"]).toMatchObject({
      type: "control-change",
      number: 64
    })
    expect(saveRow.text()).toContain("CC 64")
    expect(window.yadaw.setMidiControlLearning).toHaveBeenLastCalledWith(expect.any(Object), false)

    await saveRow.get(".clear-button").trigger("click")
    await flushPromises()
    expect(settingsStore.settings?.shortcuts.midi["project.save"]).toBeUndefined()

    await wrapper
      .findAll("button")
      .find((button) => button.text().includes("Reset all"))!
      .trigger("click")
    await flushPromises()
    expect(settingsStore.settings?.shortcuts).toEqual({ keyboard: {}, midi: {} })
  })
})

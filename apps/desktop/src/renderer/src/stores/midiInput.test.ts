import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MidiInputSnapshot, MidiSyncPreferences } from "@yadaw/contracts"
import { useApplicationSettingsStore } from "./applicationSettings"
import { useMidiInputStore } from "./midiInput"

function snapshot(overrides: Partial<MidiInputSnapshot> = {}): MidiInputSnapshot {
  return {
    ports: [
      { id: "port-1", name: "Keystation", connected: true },
      { id: "port-2", name: "Old interface", connected: false }
    ],
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
    capturedAt: 1_000,
    ...overrides
  }
}

const preferences: MidiSyncPreferences = {
  enabled: true,
  sourcePortId: "port-1",
  sourcePortName: "Keystation",
  inputOffsetsMs: { "port-1": -4 }
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi({
    midiInputSnapshot: vi.fn(async () => snapshot()),
    subscribeMidiInput: vi.fn(() => () => undefined),
    configureMidiInput: vi.fn(async () => snapshot())
  })
})

describe("load", () => {
  it("reads the snapshot and subscribes for updates", async () => {
    const store = useMidiInputStore()

    await store.load()

    expect(store.snapshot.ports).toHaveLength(2)
    expect(store.loading).toBe(false)
    expect(window.yadaw.subscribeMidiInput).toHaveBeenCalledTimes(1)
  })

  it("subscribes only once across repeated loads", async () => {
    const midiInputSnapshot = vi.fn(async () => snapshot())
    stubApi({ midiInputSnapshot })
    const store = useMidiInputStore()

    await store.load()
    await store.load()

    expect(midiInputSnapshot).toHaveBeenCalledTimes(1)
    expect(window.yadaw.subscribeMidiInput).toHaveBeenCalledTimes(1)
  })

  it("applies pushed snapshots and their sync errors", async () => {
    let push: ((next: MidiInputSnapshot) => void) | undefined
    stubApi({
      subscribeMidiInput: vi.fn((listener: (next: MidiInputSnapshot) => void) => {
        push = listener
        return () => undefined
      })
    })
    const store = useMidiInputStore()
    await store.load()

    push?.(
      snapshot({
        sync: { ...snapshot().sync, state: "lost", error: "Clock stopped" },
        capturedAt: 2_000
      })
    )

    expect(store.snapshot.capturedAt).toBe(2_000)
    expect(store.error).toBe("Clock stopped")
  })

  it("clears the error when a pushed snapshot recovers", async () => {
    let push: ((next: MidiInputSnapshot) => void) | undefined
    stubApi({
      subscribeMidiInput: vi.fn((listener: (next: MidiInputSnapshot) => void) => {
        push = listener
        return () => undefined
      })
    })
    const store = useMidiInputStore()
    await store.load()

    push?.(snapshot({ sync: { ...snapshot().sync, error: "Clock stopped" } }))
    push?.(snapshot())

    expect(store.error).toBe("")
  })

  it("reports why the port list could not be read and does not subscribe", async () => {
    stubApi({
      midiInputSnapshot: vi.fn(async () => {
        throw new Error("MIDI service is down")
      })
    })
    const store = useMidiInputStore()

    await store.load()

    expect(store.error).toBe("MIDI service is down")
    expect(store.loading).toBe(false)
    expect(window.yadaw.subscribeMidiInput).not.toHaveBeenCalled()
  })

  it("uses a generic message for non-Error rejections", async () => {
    stubApi({
      midiInputSnapshot: vi.fn().mockRejectedValue("boom")
    })
    const store = useMidiInputStore()

    await store.load()

    expect(store.error).toBe("Unable to read MIDI inputs.")
  })
})

describe("derived state", () => {
  it("lists only the currently connected ports", async () => {
    const store = useMidiInputStore()
    await store.load()

    expect(store.connectedPorts.map((port) => port.id)).toEqual(["port-1"])
  })

  it("does not flag a missing source while sync follows the internal clock", async () => {
    const store = useMidiInputStore()
    await store.load()

    expect(store.sourceMissing).toBe(false)
  })

  it("flags a sync source that is no longer connected", async () => {
    stubApi({
      midiInputSnapshot: vi.fn(async () =>
        snapshot({ sync: { ...snapshot().sync, sourcePortId: "port-2" } })
      )
    })
    const store = useMidiInputStore()
    await store.load()

    expect(store.sourceMissing).toBe(true)
  })

  it("does not flag a sync source that is still connected", async () => {
    stubApi({
      midiInputSnapshot: vi.fn(async () =>
        snapshot({ sync: { ...snapshot().sync, sourcePortId: "port-1" } })
      )
    })
    const store = useMidiInputStore()
    await store.load()

    expect(store.sourceMissing).toBe(false)
  })
})

describe("configure", () => {
  it("applies the preferences and adopts the returned snapshot", async () => {
    const configureMidiInput = vi.fn(async () => snapshot({ capturedAt: 3_000 }))
    stubApi({ configureMidiInput })
    const store = useMidiInputStore()

    await expect(store.configure(preferences)).resolves.toBe(true)

    expect(configureMidiInput).toHaveBeenCalledWith(preferences)
    expect(store.snapshot.capturedAt).toBe(3_000)
    expect(store.applying).toBe(false)
  })

  it("mirrors the preferences into loaded application settings", async () => {
    const settingsStore = useApplicationSettingsStore()
    settingsStore.settings = {
      swapDirectory: "/swap",
      recordingBitDepth: "pcm24",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "yamaha-c3",
      softwareMonitoringEnabled: false,
      midiSync: { enabled: false, sourcePortId: null, sourcePortName: null, inputOffsetsMs: {} },
      audioHostRuntime: {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      pluginEditors: {},
      shortcuts: { keyboard: {}, midi: {} },
      recentProjects: []
    }
    const store = useMidiInputStore()

    await store.configure(preferences)

    expect(settingsStore.settings?.midiSync).toEqual(preferences)
    expect(settingsStore.settings?.midiSync).not.toBe(preferences)
  })

  it("leaves unloaded application settings alone", async () => {
    const settingsStore = useApplicationSettingsStore()
    const store = useMidiInputStore()

    await store.configure(preferences)

    expect(settingsStore.settings).toBeNull()
  })

  it("reports a rejected configuration without changing the snapshot", async () => {
    stubApi({
      configureMidiInput: vi.fn(async () => {
        throw new Error("Port disappeared")
      })
    })
    const store = useMidiInputStore()
    await store.load()

    await expect(store.configure(preferences)).resolves.toBe(false)

    expect(store.error).toBe("Port disappeared")
    expect(store.applying).toBe(false)
    expect(store.snapshot.capturedAt).toBe(1_000)
  })

  it("uses a generic message for non-Error rejections", async () => {
    stubApi({
      configureMidiInput: vi.fn().mockRejectedValue("boom")
    })
    const store = useMidiInputStore()

    await store.configure(preferences)

    expect(store.error).toBe("Unable to configure MIDI input.")
  })

  it("ignores a second request while one is still applying", async () => {
    let release: ((value: MidiInputSnapshot) => void) | undefined
    const configureMidiInput = vi.fn(
      () =>
        new Promise<MidiInputSnapshot>((resolve) => {
          release = resolve
        })
    )
    stubApi({ configureMidiInput })
    const store = useMidiInputStore()

    const first = store.configure(preferences)
    await expect(store.configure(preferences)).resolves.toBe(false)
    release?.(snapshot())
    await first

    expect(configureMidiInput).toHaveBeenCalledTimes(1)
  })
})

describe("dispose", () => {
  it("unsubscribes and resets to the empty snapshot", async () => {
    const unsubscribe = vi.fn()
    stubApi({
      subscribeMidiInput: vi.fn(() => unsubscribe),
      midiInputSnapshot: vi.fn(async () =>
        snapshot({ sync: { ...snapshot().sync, error: "Clock stopped" } })
      )
    })
    const store = useMidiInputStore()
    await store.load()

    store.dispose()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(store.snapshot.ports).toEqual([])
    expect(store.snapshot.capturedAt).toBe(0)
    expect(store.error).toBe("")
  })

  it("allows a later load to subscribe again", async () => {
    const store = useMidiInputStore()
    await store.load()
    store.dispose()

    await store.load()

    expect(window.yadaw.subscribeMidiInput).toHaveBeenCalledTimes(2)
  })

  it("is safe to call before anything was loaded", () => {
    const store = useMidiInputStore()

    expect(() => store.dispose()).not.toThrow()
  })
})

function controlSnapshot(generations: number[]): MidiInputSnapshot {
  return snapshot({
    ports: [{ id: "controller", name: "Controller", connected: true }],
    controlEvents: generations.map((generation) => ({
      generation,
      timestampMicroseconds: generation * 100,
      portId: "controller",
      portName: "Controller",
      channel: 0,
      type: "note",
      number: 36,
      value: 100
    })),
    capturedAt: Date.now()
  })
}

describe("midi input control events", () => {
  let publish: ((value: MidiInputSnapshot) => void) | null

  beforeEach(() => {
    setActivePinia(createPinia())
    publish = null
    window.yadaw.midiInputSnapshot = vi.fn().mockResolvedValue(controlSnapshot([1, 2]))
    window.yadaw.subscribeMidiInput = vi.fn((listener) => {
      publish = listener
      return () => undefined
    })
  })

  it("publishes each new generation once and ignores snapshot history", async () => {
    const store = useMidiInputStore()
    const controls = vi.fn()
    store.subscribeControls(controls)
    await store.load()

    expect(controls).not.toHaveBeenCalled()
    publish?.(controlSnapshot([2, 3]))
    publish?.(controlSnapshot([2, 3]))

    expect(controls).toHaveBeenCalledOnce()
    expect(controls).toHaveBeenCalledWith(expect.objectContaining({ generation: 3, number: 36 }))
  })
})

import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  MidiInputSnapshot,
  MidiRuntimeResourceSnapshot,
  MidiSyncPreferences,
  RpcResult
} from "@heron/contracts"
import { useApplicationSettingsStore } from "./applicationSettings"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useMidiInputStore } from "./midiInput"
import { rpcEvent } from "../test/ipc"

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

function resource(value: MidiInputSnapshot): MidiRuntimeResourceSnapshot {
  return {
    runtime: midiRuntime,
    host,
    revision: 1,
    snapshot: structuredClone(value)
  }
}

function success(value: MidiInputSnapshot): RpcResult<MidiRuntimeResourceSnapshot> {
  return {
    ok: true,
    requestId: "midi-request",
    resourceRevision: 1,
    value: resource(value),
    warnings: []
  }
}

function failure(): RpcResult<MidiRuntimeResourceSnapshot> {
  return {
    ok: false,
    requestId: "midi-request",
    error: {
      code: "resource-unavailable",
      category: "unavailable",
      outcome: "not-committed",
      retry: "safe",
      correlationId: "midi-test",
      userMessageKey: "missing.midi.test.error",
      resource: midiRuntime,
      details: {
        type: "resource-unavailable",
        component: "audio-host",
        dispatched: true
      }
    }
  }
}

function stubApi(overrides: Record<string, unknown>): void {
  const wrapped = { ...overrides }
  const snapshotCall = overrides.midiInputSnapshot
  if (typeof snapshotCall === "function") {
    wrapped.midiInputSnapshot = vi.fn(async () => {
      try {
        return success((await snapshotCall()) as MidiInputSnapshot)
      } catch {
        return failure()
      }
    })
  }
  const subscribeCall = overrides.subscribeMidiInput
  if (typeof subscribeCall === "function") {
    wrapped.subscribeMidiInput = vi.fn(
      (listener: Parameters<typeof window.heron.subscribeMidiInput>[0]) =>
        subscribeCall((value: MidiInputSnapshot) =>
          listener(rpcEvent(resource(value), value.capturedAt, host.epoch))
        )
    )
  }
  const configureCall = overrides.configureMidiInput
  if (typeof configureCall === "function") {
    wrapped.configureMidiInput = vi.fn(async (_meta: unknown, value: MidiSyncPreferences) => {
      try {
        return success((await configureCall(value)) as MidiInputSnapshot)
      } catch {
        return failure()
      }
    })
  }
  const learningCall = overrides.setMidiControlLearning
  if (typeof learningCall === "function") {
    wrapped.setMidiControlLearning = vi.fn(async (_meta: unknown, value: boolean) => {
      try {
        await learningCall(value)
        return success(snapshot())
      } catch {
        return failure()
      }
    })
  }
  Object.assign(window.heron as unknown as Record<string, unknown>, wrapped)
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi({
    midiInputSnapshot: vi.fn(async () => snapshot()),
    subscribeMidiInput: vi.fn(() => () => undefined),
    configureMidiInput: vi.fn(async () => snapshot()),
    setMidiControlLearning: vi.fn(async () => undefined)
  })
  useAudioRuntimeStore().applyResources({
    host,
    engine: null,
    transport: null,
    midiRuntime,
    revision: 0
  })
})

describe("load", () => {
  it("reads the snapshot and subscribes for updates", async () => {
    const store = useMidiInputStore()

    await store.load()

    expect(store.snapshot.ports).toHaveLength(2)
    expect(store.loading).toBe(false)
    expect(window.heron.subscribeMidiInput).toHaveBeenCalledTimes(1)
  })

  it("subscribes only once across repeated loads", async () => {
    const midiInputSnapshot = vi.fn(async () => snapshot())
    stubApi({ midiInputSnapshot })
    const store = useMidiInputStore()

    await store.load()
    await store.load()

    expect(midiInputSnapshot).toHaveBeenCalledTimes(2)
    expect(window.heron.subscribeMidiInput).toHaveBeenCalledTimes(1)
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

  it("reports a typed failure after subscribing for a gap-free snapshot", async () => {
    stubApi({
      midiInputSnapshot: vi.fn(async () => {
        throw new Error("MIDI service is down")
      })
    })
    const store = useMidiInputStore()

    await store.load()

    expect(store.error).toBe("resource-unavailable")
    expect(store.loading).toBe(false)
    expect(window.heron.subscribeMidiInput).toHaveBeenCalledOnce()
  })

  it("maps non-Error transport failures to the typed unavailable error", async () => {
    stubApi({
      midiInputSnapshot: vi.fn().mockRejectedValue("boom")
    })
    const store = useMidiInputStore()

    await store.load()

    expect(store.error).toBe("resource-unavailable")
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
        maxBlockingThreads: "auto"
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

    expect(store.error).toBe("resource-unavailable")
    expect(store.applying).toBe(false)
    expect(store.snapshot.capturedAt).toBe(1_000)
  })

  it("maps non-Error configuration failures to the typed unavailable error", async () => {
    stubApi({
      configureMidiInput: vi.fn().mockRejectedValue("boom")
    })
    const store = useMidiInputStore()

    await store.configure(preferences)

    expect(store.error).toBe("resource-unavailable")
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

    expect(window.heron.subscribeMidiInput).toHaveBeenCalledTimes(2)
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
    stubApi({
      midiInputSnapshot: vi.fn().mockResolvedValue(controlSnapshot([1, 2])),
      subscribeMidiInput: vi.fn((listener: (value: MidiInputSnapshot) => void) => {
        publish = listener
        return () => undefined
      })
    })
    useAudioRuntimeStore().applyResources({
      host,
      engine: null,
      transport: null,
      midiRuntime,
      revision: 0
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

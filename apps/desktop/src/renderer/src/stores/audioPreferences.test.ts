import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_AUDIO_PREFERENCES, INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type {
  AudioBackendDescriptor,
  AudioDeviceList,
  AudioPreferences,
  AudioRuntimeSnapshot
} from "@yadaw/contracts"
import { useAudioPreferencesStore } from "./audioPreferences"
import { useAudioRuntimeStore } from "./audioRuntime"

const STORAGE_KEY = "yadaw.audio-preferences.v1"

function preferences(overrides: Partial<AudioPreferences> = {}): AudioPreferences {
  return {
    backend: "alsa",
    inputDeviceId: "in-1",
    outputDeviceId: "out-1",
    bufferSize: 256,
    ...overrides
  }
}

function runtimeSnapshot(overrides: Partial<AudioRuntimeSnapshot> = {}): AudioRuntimeSnapshot {
  return { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, state: "running", ...overrides }
}

function device(id: string, isDefault = false) {
  return {
    id,
    name: id.toUpperCase(),
    isDefault,
    defaultSampleRate: 48_000,
    minBufferSize: 32,
    maxBufferSize: 2_048,
    channelCount: 2
  }
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

/**
 * The renderer test environment does not provide a Web Storage implementation,
 * so the store's persistence layer needs one installed before it is created.
 */
function installMemoryStorage(): Storage {
  const entries = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return entries.size
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => void entries.delete(key),
    setItem: (key, value) => void entries.set(key, value)
  }
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage })
  return storage
}

let storage: Storage

beforeEach(() => {
  setActivePinia(createPinia())
  storage = installMemoryStorage()
})

describe("persisted preferences", () => {
  it("starts from the shared defaults when nothing is stored", () => {
    const store = useAudioPreferencesStore()

    expect(store.preferences).toEqual(DEFAULT_AUDIO_PREFERENCES)
  })

  it("restores a complete stored selection", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences()))

    expect(useAudioPreferencesStore().preferences).toEqual(preferences())
  })

  it("falls back to the defaults when the stored backend is not a known cpal host", () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...preferences(), backend: "jack-from-the-future" })
    )

    expect(useAudioPreferencesStore().preferences).toEqual(DEFAULT_AUDIO_PREFERENCES)
  })

  it("rejects buffer sizes outside the range the engine can honor", () => {
    for (const bufferSize of [8, 32_768, 256.5]) {
      setActivePinia(createPinia())
      storage = installMemoryStorage()
      storage.setItem(STORAGE_KEY, JSON.stringify(preferences({ bufferSize })))

      expect(useAudioPreferencesStore().preferences).toEqual(DEFAULT_AUDIO_PREFERENCES)
    }
  })

  it("falls back to the defaults for malformed storage payloads", () => {
    storage.setItem(STORAGE_KEY, JSON.stringify("not-an-object"))

    expect(useAudioPreferencesStore().preferences).toEqual(DEFAULT_AUDIO_PREFERENCES)
  })
})

describe("apply", () => {
  it("starts the engine and stores the accepted preferences", async () => {
    const startAudioEngine = vi.fn(async () => runtimeSnapshot({ outputBufferSize: 256 }))
    stubApi({ startAudioEngine })
    const store = useAudioPreferencesStore()

    await expect(store.apply(preferences())).resolves.toBe(true)

    expect(startAudioEngine).toHaveBeenCalledWith(preferences())
    expect(store.preferences).toEqual(preferences())
    expect(store.applying).toBe(false)
    expect(store.applyError).toBe("")
  })

  it("adopts the buffer size the engine actually negotiated and explains the fallback", async () => {
    stubApi({
      startAudioEngine: vi.fn(async () =>
        runtimeSnapshot({ outputBufferSize: 512, bufferFallback: true })
      )
    })
    const store = useAudioPreferencesStore()

    await store.apply(preferences({ bufferSize: 64 }))

    expect(store.preferences.bufferSize).toBe(512)
    expect(store.applyNotice).toContain("512")
    expect(store.applyNotice).toContain("64")
  })

  it("reports the engine failure and leaves applying settled", async () => {
    stubApi({
      startAudioEngine: vi.fn(async () => {
        throw new Error("Device is in use")
      })
    })
    const store = useAudioPreferencesStore()

    await expect(store.apply(preferences())).resolves.toBe(false)

    expect(store.applyError).toBe("Device is in use")
    expect(store.applying).toBe(false)
  })

  it("describes non-Error rejections without leaking the raw value", async () => {
    stubApi({ startAudioEngine: vi.fn().mockRejectedValue("alsa exploded") })
    const store = useAudioPreferencesStore()

    await store.apply(preferences())

    expect(store.applyError).toBe("Unable to start the native audio engine.")
  })

  it("skips a restart when the running engine already uses those preferences", async () => {
    const startAudioEngine = vi.fn(async () => runtimeSnapshot())
    stubApi({ startAudioEngine })
    const store = useAudioPreferencesStore()
    useAudioRuntimeStore().applyLifecycleState({
      status: "running",
      runtime: runtimeSnapshot(),
      error: null
    })
    await store.apply(preferences())
    startAudioEngine.mockClear()

    await expect(store.apply(store.preferences)).resolves.toBe(true)

    expect(startAudioEngine).not.toHaveBeenCalled()
  })

  it("restarts the engine when any single preference differs", async () => {
    const startAudioEngine = vi.fn(async () => runtimeSnapshot())
    stubApi({ startAudioEngine })
    const store = useAudioPreferencesStore()
    useAudioRuntimeStore().applyLifecycleState({
      status: "running",
      runtime: runtimeSnapshot(),
      error: null
    })
    await store.apply(preferences())
    startAudioEngine.mockClear()

    await store.apply(preferences({ inputDeviceId: "in-2" }))

    expect(startAudioEngine).toHaveBeenCalledTimes(1)
  })
})

describe("restore", () => {
  it("starts the engine once when a stopped session has a saved device pair", async () => {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences()))
    const startAudioEngine = vi.fn(async () => runtimeSnapshot())
    stubApi({
      audioEngineSnapshot: vi.fn(async () => ({
        ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
        state: "stopped" as const
      })),
      startAudioEngine
    })
    const store = useAudioPreferencesStore()

    await store.restore()
    await store.restore()

    expect(startAudioEngine).toHaveBeenCalledTimes(1)
  })

  it("does nothing when no devices have been chosen yet", async () => {
    const audioEngineSnapshot = vi.fn(async () => INITIAL_AUDIO_RUNTIME_SNAPSHOT)
    stubApi({ audioEngineSnapshot })
    const store = useAudioPreferencesStore()

    await store.restore()

    expect(audioEngineSnapshot).not.toHaveBeenCalled()
  })

  it("leaves an already running engine alone", async () => {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences()))
    const startAudioEngine = vi.fn(async () => runtimeSnapshot())
    stubApi({
      audioEngineSnapshot: vi.fn(async () => runtimeSnapshot()),
      startAudioEngine
    })
    const store = useAudioPreferencesStore()

    await store.restore()

    expect(startAudioEngine).not.toHaveBeenCalled()
  })
})

describe("backend discovery", () => {
  const backends: AudioBackendDescriptor[] = [
    { id: "alsa", label: "ALSA", available: true },
    { id: "asio", label: "ASIO", available: false }
  ]

  it("publishes the reported backends and marks discovery ready", async () => {
    stubApi({ listAudioBackends: vi.fn(async () => backends) })
    const store = useAudioPreferencesStore()

    await expect(store.discoverBackends()).resolves.toEqual(backends)

    expect(store.backends).toEqual(backends)
    expect(store.discoveryState).toBe("ready")
    expect(store.discoveryError).toBe("")
  })

  it("marks discovery unavailable when the host query fails", async () => {
    stubApi({
      listAudioBackends: vi.fn(async () => {
        throw new Error("no cpal hosts")
      })
    })
    const store = useAudioPreferencesStore()

    await expect(store.discoverBackends()).resolves.toEqual([])

    expect(store.discoveryState).toBe("unavailable")
    expect(store.discoveryError).toBe("no cpal hosts")
  })

  it("uses a generic message when the host query rejects without an Error", async () => {
    stubApi({
      listAudioBackends: vi.fn().mockRejectedValue("boom")
    })
    const store = useAudioPreferencesStore()

    await store.discoverBackends()

    expect(store.discoveryError).toBe("Unable to query cpal backends.")
  })

  it("ignores a stale backend query that resolves after a newer one", async () => {
    let releaseFirst: (value: AudioBackendDescriptor[]) => void = () => undefined
    const first = new Promise<AudioBackendDescriptor[]>((resolve) => {
      releaseFirst = resolve
    })
    const listAudioBackends = vi
      .fn<() => Promise<AudioBackendDescriptor[]>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(backends)
    stubApi({ listAudioBackends })
    const store = useAudioPreferencesStore()

    const stale = store.discoverBackends()
    await store.discoverBackends()
    releaseFirst([{ id: "coreaudio", label: "CoreAudio", available: true }])
    await stale

    expect(store.backends).toEqual(backends)
  })
})

describe("device discovery", () => {
  const devices: AudioDeviceList = {
    inputs: [device("in-1", true), device("in-2")],
    outputs: [device("out-1")]
  }

  it("splits the reported devices into inputs and outputs", async () => {
    stubApi({ listAudioDevices: vi.fn(async () => devices) })
    const store = useAudioPreferencesStore()

    await store.discoverDevices("alsa")

    expect(store.inputDevices.map((entry) => entry.id)).toEqual(["in-1", "in-2"])
    expect(store.outputDevices.map((entry) => entry.id)).toEqual(["out-1"])
    expect(store.discoveryState).toBe("ready")
  })

  it("clears the device lists when enumeration fails", async () => {
    stubApi({ listAudioDevices: vi.fn(async () => devices) })
    const store = useAudioPreferencesStore()
    await store.discoverDevices("alsa")

    stubApi({
      listAudioDevices: vi.fn(async () => {
        throw new Error("device vanished")
      })
    })
    await store.discoverDevices("alsa")

    expect(store.inputDevices).toEqual([])
    expect(store.outputDevices).toEqual([])
    expect(store.discoveryState).toBe("unavailable")
    expect(store.discoveryError).toBe("device vanished")
  })

  it("uses a generic message when enumeration rejects without an Error", async () => {
    stubApi({
      listAudioDevices: vi.fn().mockRejectedValue("boom")
    })
    const store = useAudioPreferencesStore()

    await store.discoverDevices("alsa")

    expect(store.discoveryError).toBe("cpal device enumeration failed.")
  })

  it("ignores a stale device query that resolves after a newer one", async () => {
    let releaseFirst: (value: AudioDeviceList) => void = () => undefined
    const first = new Promise<AudioDeviceList>((resolve) => {
      releaseFirst = resolve
    })
    const listAudioDevices = vi
      .fn<() => Promise<AudioDeviceList>>()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(devices)
    stubApi({ listAudioDevices })
    const store = useAudioPreferencesStore()

    const stale = store.discoverDevices("alsa")
    await store.discoverDevices("alsa")
    releaseFirst({ inputs: [device("stale")], outputs: [] })
    await stale

    expect(store.inputDevices.map((entry) => entry.id)).toEqual(["in-1", "in-2"])
  })
})

describe("markBackendUnavailable", () => {
  it("clears the device lists and records the reason", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () => ({
        inputs: [device("in-1")],
        outputs: [device("out-1")]
      }))
    })
    const store = useAudioPreferencesStore()
    await store.discoverDevices("alsa")

    store.markBackendUnavailable("ASIO driver is missing")

    expect(store.inputDevices).toEqual([])
    expect(store.outputDevices).toEqual([])
    expect(store.discoveryState).toBe("unavailable")
    expect(store.discoveryError).toBe("ASIO driver is missing")
  })

  it("cancels an in-flight device query so it cannot overwrite the reason", async () => {
    let release: (value: AudioDeviceList) => void = () => undefined
    stubApi({
      listAudioDevices: vi.fn(
        () =>
          new Promise<AudioDeviceList>((resolve) => {
            release = resolve
          })
      )
    })
    const store = useAudioPreferencesStore()

    const pending = store.discoverDevices("asio")
    store.markBackendUnavailable("ASIO driver is missing")
    release({ inputs: [device("in-1")], outputs: [] })
    await pending

    expect(store.inputDevices).toEqual([])
    expect(store.discoveryError).toBe("ASIO driver is missing")
  })
})

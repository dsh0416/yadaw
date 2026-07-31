import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ApplicationSettings,
  ApplicationSettingsResourceSnapshot,
  RpcRequestMeta,
  RpcResult
} from "@yadaw/contracts"
import { rpcFailure, rpcSuccess, settingsSnapshot, testBootstrap } from "../test/ipc"
import { useApplicationSettingsStore } from "./applicationSettings"

function settings(overrides: Partial<ApplicationSettings> = {}): ApplicationSettings {
  return {
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
    recentProjects: [],
    ...overrides
  }
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => {
  setActivePinia(createPinia())
  stubApi({
    bootstrap: vi.fn(async () =>
      rpcSuccess(testBootstrap({ settings: settingsSnapshot(settings()) }))
    ),
    getApplicationSettings: vi.fn(async () => rpcSuccess(settingsSnapshot(settings()))),
    updateApplicationSettings: vi.fn(async (_meta, patch: Partial<ApplicationSettings>) =>
      rpcSuccess(settingsSnapshot(settings(patch), 2))
    ),
    setSoftwareMonitoringEnabled: vi.fn(async (_meta, enabled: boolean) =>
      rpcSuccess(settingsSnapshot(settings({ softwareMonitoringEnabled: enabled }), 2))
    ),
    configureAudioHostRuntime: vi.fn(async () => rpcSuccess(settingsSnapshot(settings(), 2))),
    chooseSwapDirectory: vi.fn(async () =>
      rpcSuccess(settingsSnapshot(settings({ swapDirectory: "/new-swap" }), 2))
    ),
    openSwapDirectory: vi.fn(async () => rpcSuccess(undefined)),
    systemPerformanceSnapshot: vi.fn(async () => rpcSuccess({ audioIpc: null }))
  })
})

describe("load", () => {
  it("reads the settings once and clears the loading flag", async () => {
    const store = useApplicationSettingsStore()

    await store.load()

    expect(store.settings).toEqual(settings())
    expect(store.loading).toBe(false)
    expect(store.error).toBe("")
  })

  it("shares one in-flight request between concurrent callers", async () => {
    const bootstrap = vi.fn(async () =>
      rpcSuccess(testBootstrap({ settings: settingsSnapshot(settings()) }))
    )
    stubApi({ bootstrap })
    const store = useApplicationSettingsStore()

    await Promise.all([store.load(), store.load()])

    expect(bootstrap).toHaveBeenCalledTimes(1)
  })

  it("reports a failed read and allows a later retry", async () => {
    const bootstrap = vi
      .fn()
      .mockResolvedValueOnce(rpcFailure("errors.unableToLoadApplicationSettings"))
      .mockResolvedValueOnce(rpcSuccess(testBootstrap({ settings: settingsSnapshot(settings()) })))
    stubApi({ bootstrap })
    const store = useApplicationSettingsStore()

    await store.load()
    expect(store.error).not.toBe("")
    expect(store.settings).toBeNull()

    await store.load()
    expect(store.settings).toEqual(settings())
  })

  it("uses the typed error message for a failed result", async () => {
    stubApi({
      bootstrap: vi.fn().mockResolvedValue(rpcFailure("errors.unableToLoadApplicationSettings"))
    })
    const store = useApplicationSettingsStore()

    await store.load()

    expect(store.error).not.toBe("")
    expect(store.error).not.toBe("boom")
  })
})

describe("optimistic display settings", () => {
  it("loads the settings on demand before applying a theme", async () => {
    const bootstrap = vi.fn(async () =>
      rpcSuccess(testBootstrap({ settings: settingsSnapshot(settings()) }))
    )
    stubApi({ bootstrap })
    const store = useApplicationSettingsStore()

    await store.setTheme("dark")

    expect(bootstrap).toHaveBeenCalledTimes(1)
    expect(store.settings?.theme).toBe("dark")
  })

  it("skips the round trip when the theme is unchanged", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setTheme("system")

    expect(window.yadaw.updateApplicationSettings).not.toHaveBeenCalled()
  })

  it("rolls the theme back and reports the failure", async () => {
    const store = useApplicationSettingsStore()
    await store.load()
    stubApi({
      updateApplicationSettings: vi.fn(async () => rpcFailure("errors.unableToSaveDisplaySettings"))
    })

    await store.setTheme("dark")

    expect(store.settings?.theme).toBe("system")
    expect(store.error).not.toBe("")
  })

  it("reconciles and retries a non-committed revision conflict once", async () => {
    const updateApplicationSettings = vi
      .fn()
      .mockResolvedValueOnce(
        rpcFailure("errors.revisionConflict", {
          code: "revision-conflict",
          category: "conflict",
          outcome: "not-committed",
          retry: "after-reconcile",
          details: {
            type: "revision-conflict",
            expectedRevision: 1,
            actualRevision: 7
          }
        })
      )
      .mockResolvedValueOnce(rpcSuccess(settingsSnapshot(settings({ theme: "dark" }), 8)))
    const getApplicationSettings = vi.fn(async () =>
      rpcSuccess(settingsSnapshot(settings({ recentProjects: [] }), 7))
    )
    stubApi({ getApplicationSettings, updateApplicationSettings })
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setTheme("dark")

    expect(getApplicationSettings).toHaveBeenCalledTimes(1)
    expect(updateApplicationSettings).toHaveBeenCalledTimes(2)
    expect(updateApplicationSettings.mock.calls[0]?.[0].expectedRevision).toBe(1)
    expect(updateApplicationSettings.mock.calls[1]?.[0].expectedRevision).toBe(7)
    expect(store.settings?.theme).toBe("dark")
    expect(store.revision).toBe(8)
  })

  it("serializes rapid theme intents against the latest committed revision", async () => {
    let releaseFirst: ((value: RpcResult<ApplicationSettingsResourceSnapshot>) => void) | undefined
    const updateApplicationSettings = vi.fn(
      (meta: RpcRequestMeta, patch: Partial<ApplicationSettings>) => {
        if (updateApplicationSettings.mock.calls.length === 1) {
          return new Promise<RpcResult<ApplicationSettingsResourceSnapshot>>((resolve) => {
            releaseFirst = resolve
          })
        }
        return Promise.resolve(
          rpcSuccess(settingsSnapshot(settings(patch), (meta.expectedRevision ?? 0) + 1))
        )
      }
    )
    stubApi({ updateApplicationSettings })
    const store = useApplicationSettingsStore()
    await store.load()

    const light = store.setTheme("light")
    await vi.waitFor(() => expect(updateApplicationSettings).toHaveBeenCalledTimes(1))
    const dark = store.setTheme("dark")
    expect(updateApplicationSettings).toHaveBeenCalledTimes(1)

    releaseFirst?.(rpcSuccess(settingsSnapshot(settings({ theme: "light" }), 2)))
    await Promise.all([light, dark])

    expect(updateApplicationSettings).toHaveBeenCalledTimes(2)
    expect(updateApplicationSettings.mock.calls[0]?.[0].expectedRevision).toBe(1)
    expect(updateApplicationSettings.mock.calls[1]?.[0].expectedRevision).toBe(2)
    expect(store.settings?.theme).toBe("dark")
  })

  it("applies and rolls back the locale the same way", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setLocale("zh-cmn-Hans-CN")
    expect(store.settings?.locale).toBe("zh-cmn-Hans-CN")

    await store.setLocale("zh-cmn-Hans-CN")
    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledTimes(1)

    stubApi({
      updateApplicationSettings: vi.fn(async () => rpcFailure("errors.unableToSaveDisplaySettings"))
    })
    await store.setLocale("en-US")
    expect(store.settings?.locale).toBe("zh-cmn-Hans-CN")
    expect(store.error).not.toBe("")
  })

  it("applies meter peak hold and return rate", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setMeterPeakHold("4s")
    expect(store.settings?.meterPeakHold).toBe("4s")

    await store.setMeterReturnRate("iec-type-i")
    expect(window.yadaw.updateApplicationSettings).toHaveBeenLastCalledWith(expect.any(Object), {
      meterReturnRate: "iec-type-i"
    })
  })

  it("rolls meter settings back when the write fails", async () => {
    const store = useApplicationSettingsStore()
    await store.load()
    stubApi({
      updateApplicationSettings: vi.fn(async () =>
        rpcFailure("errors.unableToSaveMixerDisplaySettings")
      )
    })

    await store.setMeterPeakHold("infinite")

    expect(store.settings?.meterPeakHold).toBe("800ms")
    expect(store.error).not.toBe("")
  })

  it("gives up on meter settings when the settings never load", async () => {
    stubApi({
      bootstrap: vi.fn(async () => rpcFailure("errors.unableToLoadApplicationSettings"))
    })
    const store = useApplicationSettingsStore()

    await store.setMeterPeakHold("2s")

    expect(store.settings).toBeNull()
    expect(window.yadaw.updateApplicationSettings).not.toHaveBeenCalled()
  })

  it("applies and rolls back the center C standard", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setMidiCenterCStandard("roland-c4")
    expect(store.settings?.midiCenterCStandard).toBe("roland-c4")

    await store.setMidiCenterCStandard("roland-c4")
    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledTimes(1)

    stubApi({
      updateApplicationSettings: vi.fn(async () => rpcFailure("errors.unableToSaveMidiSettings"))
    })
    await store.setMidiCenterCStandard("yamaha-c3")
    expect(store.settings?.midiCenterCStandard).toBe("roland-c4")
    expect(store.error).not.toBe("")
  })
})

describe("update", () => {
  it("replaces the settings with whatever the main process returns", async () => {
    const store = useApplicationSettingsStore()

    await store.update({ recordingBitDepth: "float32" })

    expect(store.settings?.recordingBitDepth).toBe("float32")
  })
})

describe("swap directory", () => {
  it("adopts the directory chosen in the native picker", async () => {
    const store = useApplicationSettingsStore()

    await store.chooseSwapDirectory()

    expect(store.settings?.swapDirectory).toBe("/new-swap")
  })

  it("asks the main process to reveal the directory", async () => {
    const store = useApplicationSettingsStore()

    await store.openSwapDirectory()

    expect(window.yadaw.openSwapDirectory).toHaveBeenCalledTimes(1)
  })
})

describe("software monitoring", () => {
  it("applies the new value optimistically and keeps the confirmed result", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setSoftwareMonitoringEnabled(true)

    expect(store.settings?.softwareMonitoringEnabled).toBe(true)
    expect(store.applyingSoftwareMonitoring).toBe(false)
  })

  it("skips the round trip when the value is unchanged", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setSoftwareMonitoringEnabled(false)

    expect(window.yadaw.setSoftwareMonitoringEnabled).not.toHaveBeenCalled()
  })

  it("rolls back when the engine returns a typed failure", async () => {
    const store = useApplicationSettingsStore()
    await store.load()
    stubApi({
      setSoftwareMonitoringEnabled: vi.fn(async () => rpcFailure("errors.audioEngineUnavailable"))
    })

    await expect(store.setSoftwareMonitoringEnabled(true)).resolves.toBeUndefined()

    expect(store.settings?.softwareMonitoringEnabled).toBe(false)
    expect(store.error).not.toBe("")
    expect(store.applyingSoftwareMonitoring).toBe(false)
  })

  it("ignores a second request while one is still applying", async () => {
    let release: ((value: RpcResult<ApplicationSettingsResourceSnapshot>) => void) | undefined
    const setSoftwareMonitoringEnabled = vi.fn(
      () =>
        new Promise<RpcResult<ApplicationSettingsResourceSnapshot>>((resolve) => {
          release = resolve
        })
    )
    stubApi({ setSoftwareMonitoringEnabled })
    const store = useApplicationSettingsStore()
    await store.load()

    const first = store.setSoftwareMonitoringEnabled(true)
    await store.setSoftwareMonitoringEnabled(false)
    release?.(rpcSuccess(settingsSnapshot(settings({ softwareMonitoringEnabled: true }), 2)))
    await first

    expect(setSoftwareMonitoringEnabled).toHaveBeenCalledTimes(1)
  })
})

describe("audio host runtime", () => {
  const runtime = {
    workerThreads: 4,
    maxBlockingThreads: "auto" as const,
    egressConcurrency: 2
  }

  it("applies the preferences and refreshes the resolved diagnostics", async () => {
    stubApi({
      systemPerformanceSnapshot: vi.fn(async () =>
        rpcSuccess({
          audioIpc: {
            runtime: {
              resolved: { workerThreads: 4, maxBlockingThreads: 8, egressConcurrency: 2 }
            }
          }
        })
      )
    })
    const store = useApplicationSettingsStore()

    await store.configureAudioHostRuntime(runtime)

    expect(window.yadaw.configureAudioHostRuntime).toHaveBeenCalledWith(expect.any(Object), runtime)
    expect(store.resolvedAudioHostRuntime).toEqual({
      workerThreads: 4,
      maxBlockingThreads: 8,
      egressConcurrency: 2
    })
    expect(store.applyingAudioRuntime).toBe(false)
  })

  it("clears the resolved diagnostics when the helper reports no audio IPC", async () => {
    const store = useApplicationSettingsStore()

    await store.refreshAudioHostRuntimeDiagnostics()

    expect(store.resolvedAudioHostRuntime).toBeNull()
  })

  it("reports a typed failed restart through the local action", async () => {
    stubApi({
      configureAudioHostRuntime: vi.fn(async () => rpcFailure("errors.audioEngineUnavailable"))
    })
    const store = useApplicationSettingsStore()

    await expect(store.configureAudioHostRuntime(runtime)).rejects.toThrow()

    expect(store.error).not.toBe("")
    expect(store.applyingAudioRuntime).toBe(false)
  })

  it("ignores a second request while one is still applying", async () => {
    let release: ((value: RpcResult<ApplicationSettingsResourceSnapshot>) => void) | undefined
    const configureAudioHostRuntime = vi.fn(
      () =>
        new Promise<RpcResult<ApplicationSettingsResourceSnapshot>>((resolve) => {
          release = resolve
        })
    )
    stubApi({ configureAudioHostRuntime })
    const store = useApplicationSettingsStore()

    const first = store.configureAudioHostRuntime(runtime)
    await store.configureAudioHostRuntime(runtime)
    release?.(rpcSuccess(settingsSnapshot(settings(), 2)))
    await first

    expect(configureAudioHostRuntime).toHaveBeenCalledTimes(1)
  })
})

import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApplicationSettings } from "@yadaw/contracts"
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
    getApplicationSettings: vi.fn(async () => settings()),
    updateApplicationSettings: vi.fn(async (patch: Partial<ApplicationSettings>) =>
      settings(patch)
    ),
    setSoftwareMonitoringEnabled: vi.fn(async (enabled: boolean) =>
      settings({ softwareMonitoringEnabled: enabled })
    ),
    configureAudioHostRuntime: vi.fn(async () => settings()),
    chooseSwapDirectory: vi.fn(async () => settings({ swapDirectory: "/new-swap" })),
    openSwapDirectory: vi.fn(async () => undefined),
    systemPerformanceSnapshot: vi.fn(async () => ({ audioIpc: null }))
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
    const getApplicationSettings = vi.fn(async () => settings())
    stubApi({ getApplicationSettings })
    const store = useApplicationSettingsStore()

    await Promise.all([store.load(), store.load()])

    expect(getApplicationSettings).toHaveBeenCalledTimes(1)
  })

  it("reports a failed read and allows a later retry", async () => {
    const getApplicationSettings = vi
      .fn<() => Promise<ApplicationSettings>>()
      .mockRejectedValueOnce(new Error("settings.json is unreadable"))
      .mockResolvedValueOnce(settings())
    stubApi({ getApplicationSettings })
    const store = useApplicationSettingsStore()

    await store.load()
    expect(store.error).toBe("settings.json is unreadable")
    expect(store.settings).toBeNull()

    await store.load()
    expect(store.settings).toEqual(settings())
  })

  it("uses a translated fallback for non-Error rejections", async () => {
    stubApi({
      getApplicationSettings: vi.fn().mockRejectedValue("boom")
    })
    const store = useApplicationSettingsStore()

    await store.load()

    expect(store.error).not.toBe("")
    expect(store.error).not.toBe("boom")
  })
})

describe("optimistic display settings", () => {
  it("loads the settings on demand before applying a theme", async () => {
    const getApplicationSettings = vi.fn(async () => settings())
    stubApi({ getApplicationSettings })
    const store = useApplicationSettingsStore()

    await store.setTheme("dark")

    expect(getApplicationSettings).toHaveBeenCalledTimes(1)
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
      updateApplicationSettings: vi.fn(async () => {
        throw new Error("disk is read-only")
      })
    })

    await store.setTheme("dark")

    expect(store.settings?.theme).toBe("system")
    expect(store.error).toBe("disk is read-only")
  })

  it("applies and rolls back the locale the same way", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setLocale("zh-cmn-Hans-CN")
    expect(store.settings?.locale).toBe("zh-cmn-Hans-CN")

    await store.setLocale("zh-cmn-Hans-CN")
    expect(window.yadaw.updateApplicationSettings).toHaveBeenCalledTimes(1)

    stubApi({
      updateApplicationSettings: vi.fn(async () => {
        throw new Error("disk is read-only")
      })
    })
    await store.setLocale("en-US")
    expect(store.settings?.locale).toBe("zh-cmn-Hans-CN")
    expect(store.error).toBe("disk is read-only")
  })

  it("applies meter peak hold and return rate", async () => {
    const store = useApplicationSettingsStore()
    await store.load()

    await store.setMeterPeakHold("4s")
    expect(store.settings?.meterPeakHold).toBe("4s")

    await store.setMeterReturnRate("iec-type-i")
    expect(window.yadaw.updateApplicationSettings).toHaveBeenLastCalledWith({
      meterReturnRate: "iec-type-i"
    })
  })

  it("rolls meter settings back when the write fails", async () => {
    const store = useApplicationSettingsStore()
    await store.load()
    stubApi({
      updateApplicationSettings: vi.fn(async () => {
        throw new Error("disk is read-only")
      })
    })

    await store.setMeterPeakHold("infinite")

    expect(store.settings?.meterPeakHold).toBe("800ms")
    expect(store.error).toBe("disk is read-only")
  })

  it("gives up on meter settings when the settings never load", async () => {
    stubApi({
      getApplicationSettings: vi.fn(async () => {
        throw new Error("unreadable")
      })
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
      updateApplicationSettings: vi.fn(async () => {
        throw new Error("disk is read-only")
      })
    })
    await store.setMidiCenterCStandard("yamaha-c3")
    expect(store.settings?.midiCenterCStandard).toBe("roland-c4")
    expect(store.error).toBe("disk is read-only")
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

  it("rolls back and rethrows when the engine refuses", async () => {
    const store = useApplicationSettingsStore()
    await store.load()
    stubApi({
      setSoftwareMonitoringEnabled: vi.fn(async () => {
        throw new Error("engine is not running")
      })
    })

    await expect(store.setSoftwareMonitoringEnabled(true)).rejects.toThrow("engine is not running")

    expect(store.settings?.softwareMonitoringEnabled).toBe(false)
    expect(store.error).toBe("engine is not running")
    expect(store.applyingSoftwareMonitoring).toBe(false)
  })

  it("ignores a second request while one is still applying", async () => {
    let release: ((value: ApplicationSettings) => void) | undefined
    const setSoftwareMonitoringEnabled = vi.fn(
      () =>
        new Promise<ApplicationSettings>((resolve) => {
          release = resolve
        })
    )
    stubApi({ setSoftwareMonitoringEnabled })
    const store = useApplicationSettingsStore()
    await store.load()

    const first = store.setSoftwareMonitoringEnabled(true)
    await store.setSoftwareMonitoringEnabled(false)
    release?.(settings({ softwareMonitoringEnabled: true }))
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
      systemPerformanceSnapshot: vi.fn(async () => ({
        audioIpc: {
          runtime: {
            resolved: { workerThreads: 4, maxBlockingThreads: 8, egressConcurrency: 2 }
          }
        }
      }))
    })
    const store = useApplicationSettingsStore()

    await store.configureAudioHostRuntime(runtime)

    expect(window.yadaw.configureAudioHostRuntime).toHaveBeenCalledWith(runtime)
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

  it("reports and rethrows a failed restart", async () => {
    stubApi({
      configureAudioHostRuntime: vi.fn(async () => {
        throw new Error("helper did not come back")
      })
    })
    const store = useApplicationSettingsStore()

    await expect(store.configureAudioHostRuntime(runtime)).rejects.toThrow(
      "helper did not come back"
    )

    expect(store.error).toBe("helper did not come back")
    expect(store.applyingAudioRuntime).toBe(false)
  })

  it("ignores a second request while one is still applying", async () => {
    let release: ((value: ApplicationSettings) => void) | undefined
    const configureAudioHostRuntime = vi.fn(
      () =>
        new Promise<ApplicationSettings>((resolve) => {
          release = resolve
        })
    )
    stubApi({ configureAudioHostRuntime })
    const store = useApplicationSettingsStore()

    const first = store.configureAudioHostRuntime(runtime)
    await store.configureAudioHostRuntime(runtime)
    release?.(settings())
    await first

    expect(configureAudioHostRuntime).toHaveBeenCalledTimes(1)
  })
})

import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ApplicationSettingsStore } from "./application-settings"

describe("ApplicationSettingsStore", () => {
  it("creates defaults and atomically persists validated recording settings", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-settings-"))
    const first = new ApplicationSettingsStore(userData)
    expect(await first.get()).toMatchObject({
      recordingBitDepth: "float32",
      theme: "system",
      locale: "en-US",
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: false,
      audioHostRuntime: {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      pluginEditors: {}
    })
    await first.update({
      swapDirectory: join(userData, "custom-swap"),
      recordingBitDepth: "pcm24",
      theme: "light",
      locale: "zh-cmn-Hans-CN",
      meterPeakHold: "4s",
      midiCenterCStandard: "yamaha-c3"
    })
    const reloaded = await new ApplicationSettingsStore(userData).get()
    expect(reloaded).toMatchObject({
      swapDirectory: join(userData, "custom-swap"),
      recordingBitDepth: "pcm24",
      theme: "light",
      locale: "zh-cmn-Hans-CN",
      meterPeakHold: "4s",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "yamaha-c3"
    })
  })

  it("defaults legacy files to Roland C4 and rejects unsupported center C standards", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-midi-center-c-"))
    await writeFile(
      join(userData, "settings.json"),
      JSON.stringify({ recordingBitDepth: "pcm24" }),
      "utf8"
    )
    const store = new ApplicationSettingsStore(userData)

    expect((await store.get()).midiCenterCStandard).toBe("roland-c4")
    await expect(
      store.update({ midiCenterCStandard: "scientific" as "roland-c4" })
    ).rejects.toThrow("Unsupported MIDI center C standard")
  })

  it("migrates editor preferences and persists validated values by normalized class ID", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-editor-settings-"))
    const classId = "0123456789abcdef0123456789abcdef"
    await writeFile(
      join(userData, "settings.json"),
      JSON.stringify({
        pluginEditors: {
          [classId]: { mode: "parameters", zoomPercent: 125 },
          invalid: { mode: "native", zoomPercent: 100 },
          FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF: { mode: "native", zoomPercent: 401 }
        }
      }),
      "utf8"
    )

    const store = new ApplicationSettingsStore(userData)
    expect(await store.pluginEditorPreference(classId)).toEqual({
      mode: "parameters",
      zoomPercent: 125
    })
    expect(await store.pluginEditorPreference("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toEqual({
      mode: "native",
      zoomPercent: 100
    })

    await store.setPluginEditorPreference(classId, { mode: "native", zoomPercent: 200 })
    const reloaded = await new ApplicationSettingsStore(userData).get()
    expect(reloaded.pluginEditors["0123456789ABCDEF0123456789ABCDEF"]).toEqual({
      mode: "native",
      zoomPercent: 200
    })
    await expect(
      store.setPluginEditorPreference(classId, { mode: "native", zoomPercent: 49 })
    ).rejects.toThrow("50 to 400")
    await expect(
      store.setPluginEditorPreference("not-a-class-id", { mode: "native", zoomPercent: 100 })
    ).rejects.toThrow("class ID")
  })

  it("persists validated audio helper thread settings through the dedicated path", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-runtime-settings-"))
    const store = new ApplicationSettingsStore(userData)
    await store.configureAudioHostRuntime({
      workerThreads: 3,
      maxBlockingThreads: 6,
      egressConcurrency: 2
    })
    expect((await new ApplicationSettingsStore(userData).get()).audioHostRuntime).toEqual({
      workerThreads: 3,
      maxBlockingThreads: 6,
      egressConcurrency: 2
    })
    await expect(
      store.configureAudioHostRuntime({
        workerThreads: 9,
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      })
    ).rejects.toThrow("Worker threads")
  })

  it("defaults legacy files to disabled and persists software monitoring through its named path", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-monitoring-settings-"))
    await writeFile(
      join(userData, "settings.json"),
      JSON.stringify({ recordingBitDepth: "pcm24" }),
      "utf8"
    )
    const store = new ApplicationSettingsStore(userData)

    expect((await store.get()).softwareMonitoringEnabled).toBe(false)
    await store.setSoftwareMonitoringEnabled(true)

    expect((await new ApplicationSettingsStore(userData).get()).softwareMonitoringEnabled).toBe(
      true
    )
  })
})

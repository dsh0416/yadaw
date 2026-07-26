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
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
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
      meterPeakHold: "4s"
    })
    const reloaded = await new ApplicationSettingsStore(userData).get()
    expect(reloaded).toMatchObject({
      swapDirectory: join(userData, "custom-swap"),
      recordingBitDepth: "pcm24",
      theme: "light",
      meterPeakHold: "4s",
      meterReturnRate: "iec-type-i"
    })
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
})

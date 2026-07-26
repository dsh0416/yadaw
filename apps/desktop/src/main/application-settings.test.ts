import { mkdtemp } from "node:fs/promises"
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
      }
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

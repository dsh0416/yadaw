import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ApplicationSettingsStore } from "./application-settings"

describe("ApplicationSettingsStore", () => {
  it("creates defaults and atomically persists validated recording settings", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-settings-"))
    const first = new ApplicationSettingsStore(userData)
    expect(await first.get()).toMatchObject({ recordingBitDepth: "float32", theme: "system" })
    await first.update({
      swapDirectory: join(userData, "custom-swap"),
      recordingBitDepth: "pcm24",
      theme: "light"
    })
    const reloaded = await new ApplicationSettingsStore(userData).get()
    expect(reloaded).toMatchObject({
      swapDirectory: join(userData, "custom-swap"),
      recordingBitDepth: "pcm24",
      theme: "light"
    })
  })
})

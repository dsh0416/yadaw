import { test, expect, _electron as electron } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("measures mock round-trip latency through the desktop boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "yadaw-loopback-e2e-"))
  const executablePath = process.env.YADAW_E2E_EXECUTABLE
  const application = await electron.launch({
    executablePath,
    args: [
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu-sandbox",
      "--no-sandbox",
      ...(executablePath ? [] : [resolve(import.meta.dirname, "..")])
    ],
    env: {
      ...process.env,
      YADAW_TEST_USER_DATA: join(testRoot, "user-data"),
      YADAW_TEST_PROJECT_PATH: join(testRoot, "loopback.yadaw"),
      YADAW_TEST_MOCK_AUDIO: "1"
    }
  })

  try {
    await application.firstWindow()
    const page =
      application.windows().find((candidate) => !candidate.url().includes("splash.html")) ??
      (await application.waitForEvent("window", {
        predicate: (candidate) => !candidate.url().includes("splash.html")
      }))
    await page.waitForLoadState("domcontentloaded")
    await expect(page.getByRole("heading", { name: /Build a session/ })).toBeVisible()

    const runtime = await page.evaluate(() =>
      window.yadaw.startAudioEngine({
        backend: "mock",
        inputDeviceId: "custom:mock-duplex",
        outputDeviceId: "custom:mock-duplex",
        bufferSize: 128
      } as Parameters<typeof window.yadaw.startAudioEngine>[0])
    )
    expect(runtime.state).toBe("running")

    const started = await page.evaluate(() =>
      window.yadaw.startRoundTripLatencyMeasurement({
        inputChannel: 1,
        outputChannel: 1
      })
    )
    expect(started).toMatchObject({
      status: "preparing",
      inputChannel: 1,
      outputChannel: 1
    })
    await expect
      .poll(async () => {
        const measurement = await page.evaluate(() =>
          window.yadaw.roundTripLatencyMeasurementSnapshot()
        )
        return {
          status: measurement.status,
          measured: measurement.measuredRoundTripLatencyMs
        }
      })
      .toMatchObject({ status: "complete", measured: expect.any(Number) })

    await page.evaluate(() => window.yadaw.stopAudioEngine())
  } finally {
    await application.close()
  }
})

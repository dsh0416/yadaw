import { test, expect, _electron as electron } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("measures mock round-trip latency through the desktop boundary", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "heron-loopback-e2e-"))
  const executablePath = process.env.HERON_E2E_EXECUTABLE
  const application = await electron.launch({
    executablePath,
    args: [
      ...(process.platform === "linux" ? ["--ozone-platform=x11"] : []),
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu-sandbox",
      "--no-sandbox",
      ...(executablePath ? [] : [resolve(import.meta.dirname, "..")])
    ],
    env: {
      ...process.env,
      HERON_TEST_USER_DATA: join(testRoot, "user-data"),
      HERON_TEST_PROJECT_PATH: join(testRoot, "loopback.heron"),
      HERON_TEST_MOCK_AUDIO: "1"
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
    await expect(page.getByRole("heading", { name: /Make sound/ })).toBeVisible()

    const runtime = await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok) throw new Error(bootstrap.error.code)
      const result = await window.heron.startAudioEngine(
        {
          protocolVersion: 2,
          requestId: crypto.randomUUID(),
          target: bootstrap.value.audioResources.host,
          mutation: {
            operationId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID()
          }
        },
        {
          backend: "mock",
          inputDeviceId: "custom:mock-duplex",
          outputDeviceId: "custom:mock-duplex",
          bufferSize: 128
        }
      )
      if (!result.ok) throw new Error(result.error.code)
      return result.value.runtime
    })
    expect(runtime.state).toBe("running")

    const started = await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok) throw new Error(bootstrap.error.code)
      return window.heron.startRoundTripLatencyMeasurement(
        {
          protocolVersion: 2,
          requestId: crypto.randomUUID(),
          target: bootstrap.value.audioResources.host,
          mutation: {
            operationId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID()
          }
        },
        {
          inputChannel: 1,
          outputChannel: 1
        }
      )
    })
    if (!started.ok) throw new Error(JSON.stringify(started.error))
    expect(started.ok).toBe(true)
    expect(started).toMatchObject({
      value: {
        status: "preparing",
        inputChannel: 1,
        outputChannel: 1
      }
    })
    await expect
      .poll(async () => {
        const measurement = await page.evaluate(async () => {
          const bootstrap = await window.heron.bootstrap({
            protocolVersion: 2,
            requestId: crypto.randomUUID()
          })
          if (!bootstrap.ok) throw new Error(bootstrap.error.code)
          return window.heron.roundTripLatencyMeasurementSnapshot({
            protocolVersion: 2,
            requestId: crypto.randomUUID(),
            target: bootstrap.value.audioResources.host
          })
        })
        if (!measurement.ok) throw new Error(measurement.error.code)
        return {
          status: measurement.value.status,
          measured: measurement.value.measuredRoundTripLatencyMs
        }
      })
      .toMatchObject({ status: "complete", measured: expect.any(Number) })

    await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.audioResources.engine) return
      const result = await window.heron.stopAudioEngine({
        protocolVersion: 2,
        requestId: crypto.randomUUID(),
        target: bootstrap.value.audioResources.engine,
        mutation: {
          operationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID()
        }
      })
      if (!result.ok) throw new Error(result.error.code)
    })
  } finally {
    await application.close()
  }
})

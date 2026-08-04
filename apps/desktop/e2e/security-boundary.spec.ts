import { expect, test, _electron as electron } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("loads fixed custom-protocol entrypoints with isolated preload bridges", async () => {
  test.setTimeout(90_000)
  const testRoot = await mkdtemp(join(tmpdir(), "heron-security-e2e-"))
  const executablePath = process.env.HERON_E2E_EXECUTABLE
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
      HERON_TEST_USER_DATA: join(testRoot, "user-data"),
      HERON_TEST_CAPTURE_SOURCE: "1",
      HERON_TEST_MOCK_AUDIO: "1"
    }
  })

  try {
    const splash = await application.firstWindow()
    await splash.waitForLoadState("domcontentloaded")
    expect(splash.url()).toBe("heron-app://bundle/splash.html")
    await expect(splash.getByRole("progressbar")).toBeVisible()
    expect(
      await splash.evaluate(() => ({
        heron: typeof (window as unknown as Record<string, unknown>).heron,
        heronSplash: typeof (window as unknown as Record<string, unknown>).heronSplash
      }))
    ).toEqual({ heron: "undefined", heronSplash: "object" })

    const page =
      application.windows().find((candidate) => !candidate.url().includes("splash.html")) ??
      (await application.waitForEvent("window", {
        predicate: (candidate) => !candidate.url().includes("splash.html")
      }))
    await page.waitForLoadState("domcontentloaded")
    expect(page.url()).toMatch(/^heron-app:\/\/bundle\/index\.html(?:#.*)?$/)
    expect(
      await page.evaluate(() => ({
        heron: typeof (window as unknown as Record<string, unknown>).heron,
        heronSplash: typeof (window as unknown as Record<string, unknown>).heronSplash
      }))
    ).toEqual({ heron: "object", heronSplash: "undefined" })

    await page.evaluate(() => {
      window.location.hash = "/settings/system"
    })
    await expect(page.getByRole("heading", { name: "System settings" })).toBeVisible()
    expect(page.url()).toContain("#/settings/system")
  } finally {
    await application.close()
  }
})

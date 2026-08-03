import { expect, test, _electron as electron } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("prompts before closing a project with a committed mutation", async () => {
  test.setTimeout(60_000)
  const testRoot = await mkdtemp(join(tmpdir(), "heron-unsaved-close-"))
  const application = await electron.launch({
    executablePath: process.env.HERON_E2E_EXECUTABLE,
    args: [
      "--disable-gpu",
      "--disable-gpu-compositing",
      "--disable-gpu-sandbox",
      "--no-sandbox",
      ...(process.env.HERON_E2E_EXECUTABLE ? [] : [resolve(import.meta.dirname, "..")])
    ],
    env: {
      ...process.env,
      HERON_TEST_USER_DATA: join(testRoot, "user-data"),
      HERON_TEST_PROJECT_PATH: join(testRoot, "unsaved.yadaw"),
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
    await expect(page.getByRole("heading", { name: /Build a session/ })).toBeVisible()

    await page.getByRole("button", { name: "Create project" }).click()
    await expect(page.locator(".studio-shell")).toBeVisible()
    await page.getByRole("button", { name: "Add audio track" }).click()
    await expect(page.getByLabel("Unsaved changes")).toBeVisible()
    await expect
      .poll(async () => {
        const bootstrap = await page.evaluate(() =>
          window.heron.bootstrap({
            protocolVersion: 2,
            requestId: crypto.randomUUID()
          })
        )
        return bootstrap.ok ? bootstrap.value.workspace?.session.dirty : undefined
      })
      .toBe(true)

    const closeShortcutHandled = await page.evaluate(() => {
      const event = new KeyboardEvent("keydown", {
        code: "KeyW",
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
      return !window.dispatchEvent(event)
    })
    expect(closeShortcutHandled).toBe(true)
    const closeDialog = page.getByRole("alertdialog")
    await expect(
      closeDialog.getByRole("heading", { name: "Save project before closing?" })
    ).toBeVisible()
    await closeDialog.getByRole("button", { name: "Cancel" }).click()

    await expect(closeDialog).toBeHidden()
    await expect(page.locator(".studio-shell")).toBeVisible()

    const closed = await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.workspace) return false
      const result = await window.heron.closeProject(
        {
          protocolVersion: 2,
          requestId: crypto.randomUUID(),
          target: bootstrap.value.workspace.project,
          mutation: {
            operationId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID()
          }
        },
        "discard"
      )
      return result.ok && result.value.closed
    })
    expect(closed).toBe(true)
  } finally {
    await application.close()
  }
})

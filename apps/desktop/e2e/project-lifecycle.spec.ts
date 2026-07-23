import { test, expect, _electron as electron } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("records into a Large Object and reopens the PGlite project archive", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "yadaw-e2e-"))
  const projectPath = join(testRoot, "lifecycle.yadaw")
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
      YADAW_TEST_PROJECT_PATH: projectPath,
      YADAW_TEST_CAPTURE_SOURCE: "1"
    }
  })
  application.process().stdout?.on("data", (data) => console.log(`main stdout: ${String(data)}`))
  application.process().stderr?.on("data", (data) => console.log(`main stderr: ${String(data)}`))
  try {
    const page = await application.firstWindow()
    page.on("console", (message) => console.log(`renderer ${message.type()}: ${message.text()}`))
    page.on("pageerror", (error) => console.log(`renderer error: ${error.message}`))
    await page.waitForLoadState("domcontentloaded")
    console.log(`renderer url: ${page.url()}`)
    await expect(page.getByRole("heading", { name: /Build a session/ })).toBeVisible()
    await page.getByRole("button", { name: "Create project" }).click()
    await expect(page.getByText("Untitled project", { exact: false }).first()).toBeVisible()

    await page.getByRole("button", { name: "Project settings" }).click()
    await expect(page.getByRole("heading", { name: "Project Settings" })).toBeVisible()
    await page.getByLabel("Project name").fill("Lifecycle")
    await page.getByLabel("Tempo").fill("132.5")
    await page.getByLabel("Sample rate").selectOption("44100")
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByRole("status")).toContainText("Changes saved")
    await page.getByRole("button", { name: "Back to studio" }).click()
    await expect(page.getByText("Lifecycle", { exact: false }).first()).toBeVisible()

    const recordButton = page.getByRole("button", { name: "Record", exact: true })
    await recordButton.evaluate((button) => {
      button.removeAttribute("disabled")
      button.click()
    })
    await expect(page.getByText("Recording", { exact: false }).first()).toBeVisible()
    await recordButton.click()
    const recordingDialog = page.getByRole("dialog")
    await expect(recordingDialog).toContainText("Finalizing")
    await expect(recordingDialog).toContainText("Completed")
    await expect(recordingDialog).toBeHidden({ timeout: 3_000 })
    const timelineClip = page.getByRole("button", { name: /Audio clip Recording/ })
    await expect(timelineClip).toBeVisible()
    await timelineClip.click()
    await expect(timelineClip).toHaveAttribute("aria-pressed", "true")
    const playButton = page.getByRole("button", { name: "Play" })
    await expect(playButton).toBeEnabled()
    await playButton.click()
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()
    await page.getByRole("button", { name: "Pause" }).click()
    await page.getByRole("button", { name: "Go to start" }).click()
    await expect(page.getByText("001·01·000")).toBeVisible()
    const pendingAfterCommit = await page.evaluate(() => window.yadaw.listPendingRecordings())
    expect(pendingAfterCommit).toHaveLength(1)
    expect(pendingAfterCommit[0]?.assetExists).toBe(true)
    await page.evaluate((id) => window.yadaw.recoverRecording(id), pendingAfterCommit[0]!.id)
    await expect(page.getByRole("dialog")).toBeHidden()
    const importedAsset = await page.evaluate(() => window.yadaw.projectQuery({
      sql: "SELECT content_hash, sample_rate, bit_depth, (SELECT count(*)::int FROM pg_largeobject_metadata) FROM assets",
      params: [],
      method: "all"
    }))
    expect(importedAsset.rows).toHaveLength(1)
    expect(importedAsset.rows[0]?.[1]).toBe(44_100)
    expect(importedAsset.rows[0]?.[2]).toBe("float32")
    expect(importedAsset.rows[0]?.[3]).toBe(1)
    const importedHash = importedAsset.rows[0]?.[0]

    await page.getByRole("button", { name: "Save project" }).click()
    const saveDialog = page.getByRole("dialog")
    await expect(saveDialog).toContainText("Saving Lifecycle")
    await expect(saveDialog).toContainText("Completed")
    await expect(saveDialog).toBeHidden({ timeout: 3_000 })

    await page.getByRole("button", { name: "Close project" }).click()
    await expect(page.getByRole("heading", { name: /Build a session/ })).toBeVisible()
    await page.getByRole("button", { name: "Lifecycle" }).click()
    await expect(page.getByText("132.50")).toBeVisible()
    await page.getByRole("button", { name: "Project settings" }).click()
    await expect(page.getByLabel("Sample rate")).toHaveValue("44100")
    await expect(page.getByLabel("Tempo")).toHaveValue("132.5")
    const reopenedAsset = await page.evaluate(() => window.yadaw.projectQuery({
      sql: "SELECT content_hash, sample_rate, bit_depth FROM assets",
      params: [],
      method: "all"
    }))
    expect(reopenedAsset.rows).toEqual([[importedHash, 44_100, "float32"]])
  } finally {
    await application.close()
  }
})

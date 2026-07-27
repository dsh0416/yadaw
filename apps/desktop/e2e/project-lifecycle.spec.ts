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
      YADAW_TEST_CAPTURE_SOURCE: "1",
      YADAW_TEST_VIRTUAL_AUDIO: "1"
    }
  })
  application.process().stdout?.on("data", (data) => console.log(`main stdout: ${String(data)}`))
  application.process().stderr?.on("data", (data) => console.log(`main stderr: ${String(data)}`))
  try {
    const splash = await application.firstWindow()
    await splash.waitForLoadState("domcontentloaded")
    await expect(splash.getByRole("heading", { name: "YADAW" })).toBeVisible()
    await expect(splash.getByRole("progressbar")).toBeVisible()
    const page =
      application.windows().find((candidate) => !candidate.url().includes("splash.html")) ??
      (await application.waitForEvent("window", {
        predicate: (candidate) => !candidate.url().includes("splash.html")
      }))
    page.on("console", (message) => console.log(`renderer ${message.type()}: ${message.text()}`))
    page.on("pageerror", (error) => console.log(`renderer error: ${error.message}`))
    await page.waitForLoadState("domcontentloaded")
    console.log(`renderer url: ${page.url()}`)

    async function expectSettingsLayoutToFit(): Promise<void> {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1120, height: 700 },
        { width: 960, height: 640 }
      ]) {
        await page.setViewportSize(viewport)
        const overflows = await page
          .getByRole("main")
          .evaluate(
            (main) =>
              main.scrollWidth > main.clientWidth ||
              document.documentElement.scrollWidth > document.documentElement.clientWidth
          )
        expect(overflows).toBe(false)
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }

    await expect(page.getByRole("heading", { name: /Build a session/ })).toBeVisible()
    await page.getByRole("button", { name: "Create project" }).click()
    await expect(page.getByText("Untitled project", { exact: false }).first()).toBeVisible()
    const selectionPolicy = await page.locator(".studio-shell").evaluate((shell) => {
      const input = document.createElement("input")
      shell.append(input)
      const policy = {
        shell: getComputedStyle(shell).userSelect,
        input: getComputedStyle(input).userSelect
      }
      input.remove()
      return policy
    })
    expect(selectionPolicy).toEqual({ shell: "none", input: "text" })

    await page.getByRole("button", { name: "Project settings" }).click()
    await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible()
    await expectSettingsLayoutToFit()
    await page.getByLabel("Project name").fill("Lifecycle")
    await page.getByLabel("Sample rate").selectOption("44100")
    await page.getByLabel("Waveform channels").selectOption("aggregate")
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByRole("status")).toContainText("Changes saved")
    await page.getByRole("button", { name: "Back to studio" }).click()
    await expect(page.getByText("Lifecycle", { exact: false }).first()).toBeVisible()
    const virtualRuntime = await page.evaluate(() =>
      window.yadaw.startAudioEngine({
        backend: "virtual",
        inputDeviceId: "virtual-input",
        outputDeviceId: "virtual-output",
        bufferSize: 256
      } as Parameters<typeof window.yadaw.startAudioEngine>[0])
    )
    expect(virtualRuntime.state).toBe("running")

    const mixerDockToggle = page.getByRole("button", { name: "Toggle mixer dock" })
    await expect(mixerDockToggle).toBeVisible()
    if ((await mixerDockToggle.getAttribute("aria-pressed")) !== "true") {
      await mixerDockToggle.click()
    }
    const visibleMixer = page.locator(".mixer-console:visible")
    await page.getByRole("button", { name: "Add audio track" }).click()
    await page.getByRole("button", { name: "Add bus" }).click()
    await expect(
      visibleMixer.getByText("2 audio · 0 instrument · 1 buses · 1 outputs")
    ).toBeVisible()
    const audioOneVolume = visibleMixer.getByRole("slider", { name: "Audio 1 volume", exact: true })
    const volumeBounds = await audioOneVolume.boundingBox()
    expect(volumeBounds).not.toBeNull()
    await page.mouse.click(
      volumeBounds.x + volumeBounds.width / 2,
      volumeBounds.y + volumeBounds.height - 10
    )
    await expect(audioOneVolume).toHaveValue("0")
    expect(await audioOneVolume.evaluate((input) => getComputedStyle(input).outlineStyle)).toBe(
      "none"
    )
    await page.getByRole("button", { name: "Undo mixer change" }).click()
    await expect(
      visibleMixer.getByText("2 audio · 0 instrument · 0 buses · 1 outputs")
    ).toBeVisible()
    await page.getByRole("button", { name: "Redo mixer change" }).click()
    await expect(
      visibleMixer.getByText("2 audio · 0 instrument · 1 buses · 1 outputs")
    ).toBeVisible()
    await visibleMixer.getByLabel("Audio 1 output").selectOption({ label: "Bus 1" })
    await visibleMixer.getByRole("button", { name: "Audio 2 input routing" }).click()
    await page.getByLabel("Input format").selectOption("mono")
    await expect
      .poll(async () => {
        const graph = await page.evaluate(() => window.yadaw.loadMixerGraph())
        return graph.channels.find((channel) => channel.name === "Audio 2")?.inputFormat
      })
      .toBe("mono")
    await visibleMixer
      .getByRole("article", { name: "Audio 1 audio channel" })
      .getByRole("button", { name: "Add send in empty slot" })
      .click()
    await page.getByRole("button", { name: "Add", exact: true }).click()
    await visibleMixer
      .getByRole("article", { name: "Audio 1 audio channel" })
      .getByRole("button", { name: "Edit send to Bus 1" })
      .click()
    await page.getByRole("button", { name: "Enable send" }).click()
    await visibleMixer.getByRole("button", { name: "Arm Audio 1" }).click()
    await visibleMixer.getByRole("button", { name: "Arm Audio 2" }).click()
    const mixerBeforeSave = await page.evaluate(() => window.yadaw.loadMixerGraph())
    expect(mixerBeforeSave.channels.map((channel) => channel.kind)).toEqual([
      "audio",
      "audio",
      "bus",
      "master",
      "output"
    ])
    expect(mixerBeforeSave.sends).toHaveLength(1)
    await expect(page.getByRole("region", { name: "Arrangement timeline" })).toBeVisible()

    const timeZoom = page.getByRole("slider", { name: "Time zoom" })
    await timeZoom.fill("50")
    await expect(timeZoom).toHaveAttribute("aria-valuetext", "100 pixels per quarter note")
    const trackHeight = page.getByRole("slider", { name: "Track height" })
    await trackHeight.fill("50")
    await expect(trackHeight).toHaveAttribute("aria-valuetext", "196 pixels")
    const waveformGain = page.getByRole("slider", { name: "Waveform gain" })
    await waveformGain.fill("50")
    await expect(waveformGain).toHaveAttribute("aria-valuetext", "2.0 times")

    const recordButton = page.getByRole("button", { name: "Record", exact: true })
    await recordButton.evaluate((button) => {
      button.removeAttribute("disabled")
      button.click()
    })
    await expect(page.getByText("Recording", { exact: false }).first()).toBeVisible()
    const liveWaveform = page.getByRole("img", { name: /Waveform, 2 channels/ })
    await expect(liveWaveform).toBeVisible()
    await expect
      .poll(async () => {
        const label = await liveWaveform.getAttribute("aria-label")
        return Number(label?.match(/(\d+) frames/)?.[1] ?? 0)
      })
      .toBeGreaterThan(0)
    const firstLiveFrames = Number(
      (await liveWaveform.getAttribute("aria-label"))?.match(/(\d+) frames/)?.[1] ?? 0
    )
    await expect
      .poll(async () => {
        const label = await liveWaveform.getAttribute("aria-label")
        return Number(label?.match(/(\d+) frames/)?.[1] ?? 0)
      })
      .toBeGreaterThan(firstLiveFrames)
    await recordButton.click()
    const recordingDialog = page.getByRole("dialog")
    await expect(
      recordingDialog.getByRole("heading", { name: "Finalizing recording" })
    ).toBeVisible()
    await expect(recordingDialog).toContainText(/Closing recording|Completed/)
    await expect(recordingDialog).toContainText("Completed")
    await expect(recordingDialog).toBeHidden({ timeout: 3_000 })
    const timelineClip = page.getByRole("button", { name: /Audio clip Recording/ }).first()
    await expect(timelineClip).toBeVisible()
    await expect(page.getByRole("button", { name: /Audio clip Recording/ })).toHaveCount(2)
    await expect(page.getByRole("img", { name: /Waveform, 2 channels/ })).toBeVisible()
    await timelineClip.click()
    await expect(timelineClip).toHaveAttribute("aria-pressed", "true")
    const playButton = page.getByRole("button", { name: "Play" })
    await expect(playButton).toBeEnabled()
    await playButton.click()
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()

    await page.getByRole("button", { name: "System settings" }).click()
    await expect(page.getByRole("heading", { name: "System settings" })).toBeVisible()
    await page.getByRole("button", { name: "Display", exact: true }).click()
    await page.getByRole("radio", { name: /Light/ }).click()
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("light")
    await expectSettingsLayoutToFit()
    await page.getByRole("radio", { name: /Dark/ }).click()
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark")
    await expectSettingsLayoutToFit()
    await page.getByRole("button", { name: "System", exact: true }).click()
    await expect(page.getByRole("heading", { name: "Runtime scheduling" })).toBeVisible()
    await page.getByLabel("Worker thread mode").selectOption("manual")
    await page.getByLabel("Worker threads").fill("1")
    await page.getByRole("button", { name: "Apply runtime settings" }).click()
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(() => window.yadaw.systemPerformanceSnapshot())
        return snapshot.audioIpc?.runtime.resolved.workerThreads
      })
      .toBe(1)
    await page.getByRole("button", { name: "Back to studio" }).click()
    await expect(page.getByText("Lifecycle", { exact: false }).first()).toBeVisible()
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()
    const mixerAfterRuntimeRestart = await page.evaluate(() => window.yadaw.loadMixerGraph())
    expect(mixerAfterRuntimeRestart.channels.map((channel) => channel.name)).toEqual(
      mixerBeforeSave.channels.map((channel) => channel.name)
    )

    await page.getByRole("button", { name: "Pause" }).click()
    await page.getByRole("button", { name: "Go to start" }).click()
    await expect(page.getByText("001·01·000")).toBeVisible()
    const pendingAfterCommit = await page.evaluate(() => window.yadaw.listPendingRecordings())
    expect(pendingAfterCommit).toHaveLength(1)
    expect(pendingAfterCommit[0]?.assetExists).toBe(true)
    await page.evaluate((id) => window.yadaw.recoverRecording(id), pendingAfterCommit[0]!.id)
    await expect(page.getByRole("dialog")).toBeHidden()
    const importedAssets = await page.evaluate(async () => {
      const assets = await window.yadaw.listProjectAssets()
      return Promise.all(
        assets.map(async (asset) => ({
          ...asset,
          frameCount: String(asset.frameCount),
          audioByteLength: (await window.yadaw.readAssetAudio(asset.id)).byteLength
        }))
      )
    })
    expect(importedAssets).toHaveLength(2)
    expect(importedAssets.map(({ sampleRate }) => sampleRate)).toEqual([44_100, 44_100])
    expect(importedAssets.map(({ channels }) => channels).sort()).toEqual([1, 2])
    expect(importedAssets.map(({ bitDepth }) => bitDepth)).toEqual(["float32", "float32"])
    expect(importedAssets.every(({ audioByteLength }) => audioByteLength > 0)).toBe(true)
    const mixerAtSave = await page.evaluate(() => window.yadaw.loadMixerGraph())

    await page.getByRole("button", { name: "Save project" }).click()
    const saveDialog = page.getByRole("dialog")
    await expect(
      saveDialog.getByRole("heading", { name: "Saving project", exact: true })
    ).toBeVisible()
    await expect(saveDialog).toContainText("Lifecycle")
    await expect(saveDialog.getByRole("heading", { name: "Saving project archive" })).toBeVisible()
    await expect(saveDialog).toContainText("Completed")
    await expect(saveDialog).toBeHidden({ timeout: 3_000 })

    await page.getByRole("button", { name: "Close project" }).click()
    await expect(page.getByRole("heading", { name: /Build a session/ })).toBeVisible()
    await page.getByRole("button", { name: "Lifecycle" }).click()
    await page.getByRole("button", { name: "Project settings" }).click()
    await expect(page.getByLabel("Sample rate")).toHaveValue("44100")
    await expect(page.getByLabel("Waveform channels")).toHaveValue("aggregate")
    const reopenedAssets = await page.evaluate(async () =>
      (await window.yadaw.listProjectAssets()).map((asset) => ({
        ...asset,
        frameCount: String(asset.frameCount)
      }))
    )
    expect(reopenedAssets).toEqual(
      importedAssets.map(({ audioByteLength: _audioByteLength, ...asset }) => asset)
    )
    const reopenedMixer = await page.evaluate(() => window.yadaw.loadMixerGraph())
    expect(reopenedMixer.channels).toEqual(mixerAtSave.channels)
    expect(reopenedMixer.sends).toEqual(mixerAtSave.sends)
    expect(reopenedMixer.clips).toHaveLength(2)
    const reopenedWaveform = await page.evaluate(async () => {
      const assets = await window.yadaw.listProjectAssets()
      const asset = assets.find(({ channels }) => channels === 2)
      if (!asset) throw new Error("Expected a stereo recording asset")
      const peakWindow = await window.yadaw.readAssetWaveform({
        id: asset.id,
        startFrame: 0,
        endFrame: Number.MAX_SAFE_INTEGER,
        maxBuckets: 100
      })
      return {
        channels: peakWindow.channels,
        bucketCount: peakWindow.bucketCount,
        byteLength: peakWindow.peaks.byteLength
      }
    })
    expect(reopenedWaveform.channels).toBe(2)
    expect(reopenedWaveform.bucketCount).toBeGreaterThan(0)
    expect(reopenedWaveform.byteLength).toBe(reopenedWaveform.bucketCount * 2 * 8)
  } finally {
    await application.close()
  }
})

import { test, expect, _electron as electron } from "@playwright/test"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

test("records into a Large Object and reopens the PGlite project archive", async () => {
  test.setTimeout(180_000)
  const testRoot = await mkdtemp(join(tmpdir(), "heron-e2e-"))
  const projectPath = join(testRoot, "lifecycle.heron")
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
      HERON_TEST_PROJECT_PATH: projectPath,
      HERON_TEST_CAPTURE_SOURCE: "1",
      HERON_TEST_MOCK_AUDIO: "1"
    }
  })
  application.process().stdout?.on("data", (data) => console.log(`main stdout: ${String(data)}`))
  application.process().stderr?.on("data", (data) => console.log(`main stderr: ${String(data)}`))
  try {
    const splash = await application.firstWindow()
    await splash.waitForLoadState("domcontentloaded")
    expect(splash.url()).toBe("heron-app://bundle/splash.html")
    expect(
      await splash.evaluate(() => ({
        heron: typeof (window as unknown as Record<string, unknown>).heron,
        heronSplash: typeof (window as unknown as Record<string, unknown>).heronSplash
      }))
    ).toEqual({ heron: "undefined", heronSplash: "object" })
    await expect(splash.getByRole("heading", { name: "Heron" })).toBeVisible()
    await expect(splash.getByRole("progressbar")).toBeVisible()
    const page =
      application.windows().find((candidate) => !candidate.url().includes("splash.html")) ??
      (await application.waitForEvent("window", {
        predicate: (candidate) => !candidate.url().includes("splash.html")
      }))
    page.on("console", (message) => console.log(`renderer ${message.type()}: ${message.text()}`))
    page.on("pageerror", (error) => console.log(`renderer error: ${error.message}`))
    await page.waitForLoadState("domcontentloaded")
    expect(page.url()).toMatch(/^heron-app:\/\/bundle\/index\.html(?:#.*)?$/)
    expect(
      await page.evaluate(() => ({
        heron: typeof (window as unknown as Record<string, unknown>).heron,
        heronSplash: typeof (window as unknown as Record<string, unknown>).heronSplash
      }))
    ).toEqual({ heron: "object", heronSplash: "undefined" })
    console.log(`renderer url: ${page.url()}`)

    async function expectSettingsLayoutToFit(): Promise<void> {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1120, height: 700 },
        { width: 960, height: 640 }
      ]) {
        await page.setViewportSize(viewport)
        const overflows = await page
          .locator(".settings-container")
          .evaluate(
            (main) =>
              main.scrollWidth > main.clientWidth ||
              document.documentElement.scrollWidth > document.documentElement.clientWidth
          )
        expect(overflows).toBe(false)
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }

    async function navigateTo(path: string): Promise<void> {
      await page.evaluate((nextPath) => {
        window.location.hash = nextPath
      }, path)
    }

    async function loadProjectGraph() {
      return page.evaluate(async () => {
        const bootstrap = await window.heron.bootstrap({
          protocolVersion: 2,
          requestId: crypto.randomUUID()
        })
        if (!bootstrap.ok || !bootstrap.value.workspace) {
          throw new Error("Project workspace is unavailable")
        }
        const result = await window.heron.loadProjectGraph({
          protocolVersion: 2,
          requestId: crypto.randomUUID(),
          target: bootstrap.value.workspace.projectGraph
        })
        if (!result.ok) throw new Error(result.error.code)
        return result.value
      })
    }

    async function expectStudioTopbarToFit(): Promise<void> {
      const topbar = page.locator(".topbar")
      await page.getByRole("button", { name: "Library" }).click()
      await expect(page.locator(".browser-panel")).toBeHidden()
      await page.getByRole("button", { name: "Library" }).click()
      await expect(page.locator(".browser-panel")).toBeVisible()

      const initialTheme = await page.locator("html").getAttribute("data-theme")
      for (const theme of ["dark", "light"]) {
        await page.locator("html").evaluate((element, nextTheme) => {
          element.dataset.theme = nextTheme
        }, theme)

        await page.setViewportSize({ width: 1440, height: 900 })
        await expect(topbar.locator("[data-topbar-group]:visible")).toHaveCount(8)
        await expect(page.getByRole("button", { name: "Inspector" })).toHaveAttribute(
          "aria-disabled",
          "true"
        )
        expect(
          await topbar.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth &&
              document.documentElement.scrollWidth <= document.documentElement.clientWidth
          )
        ).toBe(true)

        await page.setViewportSize({ width: 960, height: 640 })
        await expect(topbar.locator("[data-topbar-group]:visible")).toHaveCount(6)
        await expect(page.getByRole("button", { name: "Library" })).toBeVisible()
        await expect(page.getByRole("button", { name: "Mixer", exact: true })).toBeVisible()
        await expect(page.getByRole("button", { name: "Metronome", exact: true })).toBeVisible()
        await expect(topbar.getByRole("slider", { name: "Master quick volume" })).toBeVisible()
        await expect(page.getByText("KEY", { exact: true })).toBeHidden()
        expect(
          await topbar.evaluate(
            (element) =>
              element.scrollWidth <= element.clientWidth &&
              document.documentElement.scrollWidth <= document.documentElement.clientWidth
          )
        ).toBe(true)
      }

      await page.locator("html").evaluate((element, theme) => {
        if (theme) {
          element.dataset.theme = theme
        } else {
          delete element.dataset.theme
        }
      }, initialTheme)
      await page.setViewportSize({ width: 1440, height: 900 })
    }

    await expect(page.getByRole("heading", { name: /Make sound/ })).toBeVisible()
    await page.getByRole("button", { name: "Start creating" }).click()
    await expect(page.locator(".studio-shell")).toBeVisible()
    await expectStudioTopbarToFit()
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

    await navigateTo("/settings/project")
    await expect(page.getByRole("heading", { name: "Project settings" })).toBeVisible()
    await expectSettingsLayoutToFit()
    await page.getByLabel("Project name").fill("Lifecycle")
    await page.getByLabel("Sample rate").selectOption("44100")
    await page.getByLabel("Waveform channels").selectOption("aggregate")
    await page.getByRole("button", { name: "Save changes" }).click()
    await expect(page.getByRole("status")).toContainText("Changes saved")
    await page.getByRole("button", { name: "Back to studio" }).click()
    await expect(page.locator(".studio-shell")).toBeVisible()
    const mockRuntime = await page.evaluate(async () => {
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
          bufferSize: 256
        }
      )
      if (!result.ok) throw new Error(result.error.code)
      return result.value.runtime
    })
    expect(mockRuntime.state).toBe("running")

    const mixerDockToggle = page.getByRole("button", { name: "Mixer", exact: true })
    await expect(mixerDockToggle).toBeVisible()
    if ((await mixerDockToggle.getAttribute("aria-pressed")) !== "true") {
      await mixerDockToggle.click()
    }
    const visibleMixer = page.locator(".mixer-console:visible")
    const metronomeStrip = visibleMixer.getByRole("article", {
      name: "Metronome instrument channel"
    })
    await expect(metronomeStrip).toBeVisible()
    await expect(
      page.getByRole("region", { name: "Arrangement timeline" }).getByText("Metronome")
    ).toHaveCount(0)
    await metronomeStrip.getByRole("button", { name: "Metronome channel menu" }).click()
    await expect(page.getByRole("button", { name: "Delete Metronome" })).toHaveCount(0)
    await page.keyboard.press("Escape")

    const metronomeToggle = page.getByRole("button", { name: "Metronome", exact: true })
    await expect(metronomeToggle).toHaveAttribute("aria-pressed", "false")
    await metronomeToggle.click()
    await expect(metronomeToggle).toHaveAttribute("aria-pressed", "true")
    await page.getByRole("button", { name: "Play" }).click()
    await expect
      .poll(async () => {
        const snapshot = await page.evaluate(async () => {
          const bootstrap = await window.heron.bootstrap({
            protocolVersion: 2,
            requestId: crypto.randomUUID()
          })
          const engine = bootstrap.ok ? bootstrap.value.audioResources.engine : null
          if (!engine) throw new Error("Audio engine resource is unavailable")
          const result = await window.heron.mixerSnapshot({
            protocolVersion: 2,
            requestId: crypto.randomUUID(),
            target: engine
          })
          if (!result.ok) throw new Error(result.error.code)
          return result.value
        })
        const meter = snapshot.meters.find((candidate) => candidate.channelId === "metronome")
        return Math.max(...(meter?.heldPeak ?? [0, 0]))
      })
      .toBeGreaterThan(0)
    await page.getByRole("button", { name: "Pause" }).click()
    await page.getByRole("button", { name: "Go to beginning" }).click()

    await page.getByRole("button", { name: "Add audio track" }).click()
    await page.getByRole("button", { name: "Add aux channel" }).click()
    await expect(visibleMixer.getByText("2 audio · 0 instrument · 1 aux · 1 outputs")).toBeVisible()
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
    await expect(visibleMixer.getByText("2 audio · 0 instrument · 0 aux · 1 outputs")).toBeVisible()
    await page.getByRole("button", { name: "Redo mixer change" }).click()
    await expect(visibleMixer.getByText("2 audio · 0 instrument · 1 aux · 1 outputs")).toBeVisible()
    await visibleMixer.getByRole("button", { name: "Audio 2 input channel" }).click()
    await page.getByRole("menuitem", { name: "Buses" }).hover()
    await page.getByRole("menuitemradio", { name: "BUS 1–2" }).click()
    await visibleMixer.getByRole("button", { name: "Use mono input for Audio 2" }).click()
    await expect
      .poll(async () => {
        const graph = await loadProjectGraph()
        return graph.channels.find((channel) => channel.name === "Audio 2")?.inputFormat
      })
      .toBe("mono")
    const audioOneStrip = visibleMixer.getByRole("article", { name: "Audio 1 audio channel" })
    await audioOneStrip.getByRole("button", { name: "Audio 1 output" }).click()
    await page.getByRole("menuitem", { name: "Buses" }).hover()
    await page.getByRole("menuitemradio", { name: "BUS 3", exact: true }).click()
    await audioOneStrip.getByRole("button", { name: "Add send in empty slot" }).click()
    await page.getByRole("menuitem", { name: "Buses" }).hover()
    await page.getByRole("menuitemradio", { name: "BUS 1", exact: true }).click()
    await audioOneStrip.getByRole("button", { name: "Edit send to BUS 1" }).click()
    await page.getByLabel("Send target").selectOption("output:output-1-2")
    await page.getByRole("button", { name: "Enable send" }).click()
    await visibleMixer.getByRole("button", { name: "Arm Audio 1" }).click()
    await visibleMixer.getByRole("button", { name: "Arm Audio 2" }).click()
    const mixerBeforeSave = await loadProjectGraph()
    expect(mixerBeforeSave.channels.map((channel) => channel.kind)).toEqual([
      "audio",
      "audio",
      "instrument",
      "aux",
      "master",
      "output"
    ])
    expect(
      mixerBeforeSave.channels.find((channel) => channel.systemRole === "metronome")
    ).toMatchObject({ id: "metronome", muted: false })
    expect(mixerBeforeSave.channels.find((channel) => channel.name === "Audio 1")).toMatchObject({
      outputChannelId: null,
      outputBus: 3
    })
    expect(mixerBeforeSave.sends).toEqual([
      expect.objectContaining({
        sourceChannelId: mixerBeforeSave.channels.find((channel) => channel.name === "Audio 1")?.id,
        targetChannelId: "output-1-2",
        targetBus: null,
        enabled: true
      })
    ])
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
    const pauseButton = page.getByRole("button", { name: "Pause" })
    await expect(pauseButton).toBeVisible()
    await page.waitForTimeout(500)
    await pauseButton.click()
    await timelineClip.click({ button: "right" })
    const splitAtPlayhead = page.getByRole("menuitem", { name: /Split at playhead/ })
    await expect(splitAtPlayhead).toBeEnabled()
    await splitAtPlayhead.click()
    await expect(page.getByRole("button", { name: /Audio clip Recording/ })).toHaveCount(3)
    await page.getByRole("button", { name: "Undo mixer change" }).click()
    await expect(page.getByRole("button", { name: /Audio clip Recording/ })).toHaveCount(2)
    await page.getByRole("button", { name: "Redo mixer change" }).click()
    await expect(page.getByRole("button", { name: /Audio clip Recording/ })).toHaveCount(3)
    await page.getByRole("button", { name: "Undo mixer change" }).click()
    await expect(page.getByRole("button", { name: /Audio clip Recording/ })).toHaveCount(2)

    await expect(playButton).toBeEnabled()
    await playButton.click()
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()

    await navigateTo("/settings/system")
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
        const snapshot = await page.evaluate(async () => {
          const bootstrap = await window.heron.bootstrap({
            protocolVersion: 2,
            requestId: crypto.randomUUID()
          })
          if (!bootstrap.ok) throw new Error(bootstrap.error.code)
          const result = await window.heron.systemPerformanceSnapshot({
            protocolVersion: 2,
            requestId: crypto.randomUUID(),
            target: bootstrap.value.desktopSession
          })
          if (!result.ok) throw new Error(result.error.code)
          return result.value
        })
        return snapshot.audioIpc?.runtime.resolved.workerThreads
      })
      .toBe(1)
    await page.getByRole("button", { name: "Back to studio" }).click()
    await expect(page.locator(".studio-shell")).toBeVisible()
    await expect(page.getByRole("button", { name: "Pause" })).toBeVisible()
    const mixerAfterRuntimeRestart = await loadProjectGraph()
    expect(mixerAfterRuntimeRestart.channels.map((channel) => channel.name)).toEqual(
      mixerBeforeSave.channels.map((channel) => channel.name)
    )

    await page.getByRole("button", { name: "Pause" }).click()
    await page.getByRole("button", { name: "Go to beginning" }).click()
    await expect(page.getByRole("region", { name: "Project musical display" })).toContainText("001")
    const pendingAfterCommit = await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.workspace) {
        throw new Error("Project workspace is unavailable")
      }
      const result = await window.heron.listPendingRecordings({
        protocolVersion: 2,
        requestId: crypto.randomUUID(),
        target: bootstrap.value.workspace.project
      })
      if (!result.ok) throw new Error(result.error.code)
      return result.value
    })
    expect(pendingAfterCommit).toHaveLength(1)
    expect(pendingAfterCommit[0]?.assetExists).toBe(true)
    await page.evaluate(async (id) => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.workspace) {
        throw new Error("Project workspace is unavailable")
      }
      const result = await window.heron.recoverRecording(
        {
          protocolVersion: 2,
          requestId: crypto.randomUUID(),
          target: bootstrap.value.workspace.project,
          expectedRevision: bootstrap.value.workspace.revision,
          mutation: {
            operationId: crypto.randomUUID(),
            idempotencyKey: crypto.randomUUID()
          }
        },
        id
      )
      if (!result.ok) throw new Error(result.error.code)
    }, pendingAfterCommit[0]!.id)
    await expect(page.getByRole("dialog")).toBeHidden()
    const importedAssets = await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.workspace) {
        throw new Error("Project workspace is unavailable")
      }
      const project = bootstrap.value.workspace.project
      const listed = await window.heron.listProjectAssets({
        protocolVersion: 2,
        requestId: crypto.randomUUID(),
        target: project
      })
      if (!listed.ok) throw new Error(listed.error.code)
      return Promise.all(
        listed.value.map(async (asset) => {
          const audio = await window.heron.readAssetAudio(
            {
              protocolVersion: 2,
              requestId: crypto.randomUUID(),
              target: project
            },
            asset.id
          )
          if (!audio.ok) throw new Error(audio.error.code)
          return {
            ...asset,
            frameCount: String(asset.frameCount),
            audioByteLength: audio.value.byteLength
          }
        })
      )
    })
    expect(importedAssets).toHaveLength(2)
    expect(importedAssets.map(({ sampleRate }) => sampleRate)).toEqual([44_100, 44_100])
    expect(importedAssets.map(({ channels }) => channels).sort()).toEqual([1, 2])
    expect(importedAssets.map(({ bitDepth }) => bitDepth)).toEqual(["float32", "float32"])
    expect(importedAssets.every(({ audioByteLength }) => audioByteLength > 0)).toBe(true)
    const mixerAtSave = await loadProjectGraph()

    const saveProject = page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.workspace) {
        throw new Error("Project workspace is unavailable")
      }
      const result = await window.heron.saveProject({
        protocolVersion: 2,
        requestId: crypto.randomUUID(),
        target: bootstrap.value.workspace.project,
        mutation: {
          operationId: crypto.randomUUID(),
          idempotencyKey: crypto.randomUUID()
        }
      })
      if (!result.ok) throw new Error(result.error.code)
      return result.value
    })
    const saveDialog = page.getByRole("dialog")
    await expect(
      saveDialog.getByRole("heading", { name: "Saving project", exact: true })
    ).toBeVisible()
    await expect(saveDialog).toContainText("Lifecycle")
    await expect(saveDialog.getByRole("heading", { name: "Saving project archive" })).toBeVisible()
    await expect(saveDialog).toContainText("Completed")
    await expect(saveDialog).toBeHidden({ timeout: 3_000 })
    await saveProject

    expect(
      await page.evaluate(async () => {
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
    ).toBe(true)
    await navigateTo("/")
    await expect(page.getByRole("heading", { name: /Make sound/ })).toBeVisible()
    await page.getByRole("button", { name: "Lifecycle" }).click()
    await expect(page.locator(".studio-shell")).toBeVisible({ timeout: 20_000 })
    await page.getByRole("button", { name: "Add instrument track" }).click()
    await expect(visibleMixer.getByText("2 audio · 1 instrument · 1 aux · 1 outputs")).toBeVisible()
    await page.getByRole("button", { name: "Undo mixer change" }).click()
    await expect(visibleMixer.getByText("2 audio · 0 instrument · 1 aux · 1 outputs")).toBeVisible()
    await navigateTo("/settings/project")
    await expect(page.getByLabel("Sample rate")).toHaveValue("44100")
    await expect(page.getByLabel("Waveform channels")).toHaveValue("aggregate")
    const reopenedAssets = await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.workspace) {
        throw new Error("Project workspace is unavailable")
      }
      const result = await window.heron.listProjectAssets({
        protocolVersion: 2,
        requestId: crypto.randomUUID(),
        target: bootstrap.value.workspace.project
      })
      if (!result.ok) throw new Error(result.error.code)
      return result.value.map((asset) => ({
        ...asset,
        frameCount: String(asset.frameCount)
      }))
    })
    expect(reopenedAssets).toEqual(
      importedAssets.map(({ audioByteLength: _audioByteLength, ...asset }) => asset)
    )
    const reopenedMixer = await loadProjectGraph()
    expect(reopenedMixer.channels).toEqual(mixerAtSave.channels)
    expect(reopenedMixer.sends).toEqual(mixerAtSave.sends)
    expect(reopenedMixer.audioClips).toHaveLength(2)
    const reopenedWaveform = await page.evaluate(async () => {
      const bootstrap = await window.heron.bootstrap({
        protocolVersion: 2,
        requestId: crypto.randomUUID()
      })
      if (!bootstrap.ok || !bootstrap.value.workspace) {
        throw new Error("Project workspace is unavailable")
      }
      const project = bootstrap.value.workspace.project
      const listed = await window.heron.listProjectAssets({
        protocolVersion: 2,
        requestId: crypto.randomUUID(),
        target: project
      })
      if (!listed.ok) throw new Error(listed.error.code)
      const asset = listed.value.find(({ channels }) => channels === 2)
      if (!asset) throw new Error("Expected a stereo recording asset")
      const peakWindow = await window.heron.readAssetWaveform(
        {
          protocolVersion: 2,
          requestId: crypto.randomUUID(),
          target: project
        },
        {
          id: asset.id,
          startFrame: 0,
          endFrame: Number(asset.frameCount),
          maxBuckets: 100
        }
      )
      if (!peakWindow.ok) throw new Error(peakWindow.error.code)
      return {
        channels: peakWindow.value.channels,
        bucketCount: peakWindow.value.bucketCount,
        byteLength: peakWindow.value.peaks.byteLength
      }
    })
    expect(reopenedWaveform.channels).toBe(2)
    expect(reopenedWaveform.bucketCount).toBeGreaterThan(0)
    expect(reopenedWaveform.byteLength).toBe(reopenedWaveform.bucketCount * 2 * 8)
    expect(
      await page.evaluate(async () => {
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
    ).toBe(true)
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

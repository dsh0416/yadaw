import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { statfs } from "node:fs/promises"
import { cpus, freemem, totalmem } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { APPLICATION_WINDOW_COMMAND_IDS, AUDIO_BACKENDS, IPC_CHANNELS } from "@yadaw/contracts"
import type {
  ApplicationWindowCommandId,
  AudioBackend,
  AudioDeviceList,
  AudioPreferences,
  AudioHostRuntimePreferences,
  AudioRuntimeSnapshot,
  ApplicationSettingsPatch,
  CreateProjectRequest,
  ProcessGainRequest,
  ProjectCommand,
  ProjectCloseDisposition,
  ProjectConfiguration,
  MixerParameterPreview,
  MidiImportPlan,
  PluginParameterChange,
  TransportCommand,
  StorageSpaceSnapshot,
  SystemPerformanceSnapshot,
  WaveformWindowRequest
} from "@yadaw/contracts"
import { engineInfo, processGain } from "@yadaw/dsp-node"
import {
  ApplicationSettingsStore,
  validateAudioHostRuntimePreferences
} from "./application-settings"
import { AudioHostService } from "./audio-host-service"
import { createAudioBenchmarkReport } from "./audio-benchmark-service"
import { installApplicationMenu } from "./application-menu"
import { OperationService } from "./operation-service"
import { MixerService } from "./mixer-service"
import { MidiImportService } from "./midi-import-service"
import { LifecycleCoordinator } from "./lifecycle-coordinator"
import { ProjectService } from "./project-service"
import { PluginCatalogService } from "./plugin-catalog-service"
import { RecordingService } from "./recording-service"
import { StartupProgress } from "./startup-progress"
import { WaveformService } from "./waveform-service"

const rendererDirectory = join(import.meta.dirname, "../renderer")
const APPLICATION_ID = "dev.yadaw.studio"

if (process.platform === "win32") {
  app.setAppUserModelId(APPLICATION_ID)
} else if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", APPLICATION_ID)
}

if (process.env.YADAW_TEST_USER_DATA) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch("disable-gpu")
  app.setPath("userData", process.env.YADAW_TEST_USER_DATA)
}

interface CpuTicks {
  idle: number
  total: number
}

let previousCpuTicks: CpuTicks[] | null = null

function percentage(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.min(100, Math.max(0, (numerator / denominator) * 100))
}

function sampleCpu(): SystemPerformanceSnapshot["cpu"] {
  const processors = cpus()
  const currentTicks = processors.map(({ times }) => ({
    idle: times.idle,
    total: times.user + times.nice + times.sys + times.idle + times.irq
  }))
  const previous = previousCpuTicks
  previousCpuTicks = currentTicks

  const cores = processors.map((processor, index) => {
    const current = currentTicks[index]
    const prior = previous?.[index]
    const totalDelta = current && prior ? current.total - prior.total : 0
    const idleDelta = current && prior ? current.idle - prior.idle : 0

    return {
      index,
      speedMhz: processor.speed,
      usagePercent: prior && totalDelta > 0 ? percentage(totalDelta - idleDelta, totalDelta) : null
    }
  })

  if (!previous || previous.length !== currentTicks.length) {
    return { overallUsagePercent: null, cores }
  }

  const totals = currentTicks.reduce(
    (result, current, index) => {
      const prior = previous[index]
      if (!prior) return result
      result.total += current.total - prior.total
      result.idle += current.idle - prior.idle
      return result
    },
    { idle: 0, total: 0 }
  )

  return {
    overallUsagePercent:
      totals.total > 0 ? percentage(totals.total - totals.idle, totals.total) : null,
    cores
  }
}

async function sampleStorageSpace(
  id: StorageSpaceSnapshot["id"],
  path: string | undefined
): Promise<StorageSpaceSnapshot> {
  if (!path) {
    return { id, path: null, state: "unconfigured", totalBytes: null, freeBytes: null }
  }

  try {
    const statistics = await statfs(path, { bigint: true })
    return {
      id,
      path,
      state: "available",
      totalBytes: Number(statistics.bsize * statistics.blocks),
      freeBytes: Number(statistics.bsize * statistics.bavail)
    }
  } catch {
    return { id, path, state: "unavailable", totalBytes: null, freeBytes: null }
  }
}

async function sampleSystemPerformance(
  settings: ApplicationSettingsStore
): Promise<SystemPerformanceSnapshot> {
  const totalBytes = totalmem()
  const freeBytes = freemem()
  const applicationSettings = await settings.get()
  const [workspace, swap] = await Promise.all([
    sampleStorageSpace("workspace", join(app.getPath("userData"), "workspaces")),
    sampleStorageSpace("swap", applicationSettings.swapDirectory)
  ])

  return {
    capturedAt: Date.now(),
    cpu: sampleCpu(),
    memory: {
      totalBytes,
      usedBytes: totalBytes - freeBytes,
      freeBytes,
      usagePercent: percentage(totalBytes - freeBytes, totalBytes)
    },
    storage: [workspace, swap],
    audioIpc: audioHostService?.performanceDiagnostics() ?? null
  }
}

function validateCreateProject(value: unknown): CreateProjectRequest {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Project options must be an object")
  const request = value as CreateProjectRequest
  if (
    typeof request.name !== "string" ||
    typeof request.sampleRate !== "number" ||
    typeof request.timeSignatureNumerator !== "number" ||
    typeof request.timeSignatureDenominator !== "number" ||
    (request.waveformDisplayMode !== "separate" && request.waveformDisplayMode !== "aggregate") ||
    (request.path !== undefined && typeof request.path !== "string")
  ) {
    throw new TypeError("Invalid project options")
  }
  return request
}

function validateProjectConfiguration(value: unknown): ProjectConfiguration {
  const request = validateCreateProject(value)
  return {
    name: request.name,
    sampleRate: request.sampleRate,
    timeSignatureNumerator: request.timeSignatureNumerator,
    timeSignatureDenominator: request.timeSignatureDenominator,
    waveformDisplayMode: request.waveformDisplayMode
  }
}

function validateWaveformRequest(value: unknown): WaveformWindowRequest {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Waveform request must be an object")
  const request = value as WaveformWindowRequest
  if (
    typeof request.id !== "string" ||
    request.id.length === 0 ||
    request.id.length > 256 ||
    !Number.isSafeInteger(request.startFrame) ||
    request.startFrame < 0 ||
    !Number.isSafeInteger(request.endFrame) ||
    request.endFrame < request.startFrame ||
    !Number.isInteger(request.maxBuckets) ||
    request.maxBuckets < 1 ||
    request.maxBuckets > 4_096
  )
    throw new TypeError("Invalid waveform request")
  return request
}

function validateSettingsPatch(value: unknown): ApplicationSettingsPatch {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Settings patch must be an object")
  const patch = value as ApplicationSettingsPatch
  if (patch.swapDirectory !== undefined && typeof patch.swapDirectory !== "string") {
    throw new TypeError("Swap directory must be a string")
  }
  if (
    patch.recordingBitDepth !== undefined &&
    patch.recordingBitDepth !== "float32" &&
    patch.recordingBitDepth !== "pcm24" &&
    patch.recordingBitDepth !== "pcm16"
  ) {
    throw new TypeError("Unsupported recording bit depth")
  }
  if (
    patch.theme !== undefined &&
    patch.theme !== "light" &&
    patch.theme !== "dark" &&
    patch.theme !== "system"
  ) {
    throw new TypeError("Unsupported theme preference")
  }
  if (
    patch.meterPeakHold !== undefined &&
    patch.meterPeakHold !== "800ms" &&
    patch.meterPeakHold !== "2s" &&
    patch.meterPeakHold !== "4s" &&
    patch.meterPeakHold !== "infinite"
  ) {
    throw new TypeError("Unsupported meter peak hold")
  }
  if (patch.meterReturnRate !== undefined && patch.meterReturnRate !== "iec-type-i") {
    throw new TypeError("Unsupported meter return rate")
  }
  return patch
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame) {
    throw new Error("Rejected IPC call without a sender frame")
  }

  const senderUrl = new URL(event.senderFrame.url)
  const developmentUrl = process.env.YADAW_RENDERER_URL

  if (developmentUrl && senderUrl.origin === new URL(developmentUrl).origin) {
    return
  }

  if (senderUrl.protocol === "file:") {
    const senderPath = fileURLToPath(senderUrl)
    if (senderPath.startsWith(rendererDirectory)) {
      return
    }
  }

  throw new Error("Rejected IPC call from an untrusted renderer")
}

function validateGainRequest(value: unknown): ProcessGainRequest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Gain request must be an object")
  }

  const { samples, gain } = value as Partial<ProcessGainRequest>
  if (
    !Array.isArray(samples) ||
    samples.length > 1_000_000 ||
    samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample))
  ) {
    throw new TypeError("Samples must be a finite numeric array of at most 1,000,000 items")
  }
  if (typeof gain !== "number" || !Number.isFinite(gain) || Math.abs(gain) > 16) {
    throw new TypeError("Gain must be a finite number between -16 and 16")
  }

  return { samples, gain }
}

function validateAudioBackend(value: unknown): AudioBackend {
  if (process.env.YADAW_TEST_VIRTUAL_AUDIO === "1" && value === "virtual") {
    return value as AudioBackend
  }
  if (typeof value !== "string" || !AUDIO_BACKENDS.includes(value as AudioBackend)) {
    throw new TypeError("Unknown audio backend")
  }

  return value as AudioBackend
}

function validateApplicationWindowCommand(value: unknown): ApplicationWindowCommandId {
  if (
    typeof value !== "string" ||
    !APPLICATION_WINDOW_COMMAND_IDS.includes(value as ApplicationWindowCommandId)
  ) {
    throw new TypeError("Unknown application window command")
  }
  return value as ApplicationWindowCommandId
}

function validateAudioPreferences(value: unknown): AudioPreferences {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Audio preferences must be an object")
  }

  const preferences = value as Partial<AudioPreferences>
  const backend = validateAudioBackend(preferences.backend)
  if (typeof preferences.inputDeviceId !== "string" || !preferences.inputDeviceId) {
    throw new TypeError("An input device is required")
  }
  if (typeof preferences.outputDeviceId !== "string" || !preferences.outputDeviceId) {
    throw new TypeError("An output device is required")
  }
  if (
    typeof preferences.bufferSize !== "number" ||
    !Number.isInteger(preferences.bufferSize) ||
    preferences.bufferSize < 16 ||
    preferences.bufferSize > 16_384
  ) {
    throw new TypeError("Unsupported audio buffer size")
  }

  return {
    backend,
    inputDeviceId: preferences.inputDeviceId,
    outputDeviceId: preferences.outputDeviceId,
    bufferSize: preferences.bufferSize
  }
}

function normalizeAudioDeviceList(devices: AudioDeviceList): AudioDeviceList {
  return devices
}

function normalizeAudioRuntime(snapshot: AudioRuntimeSnapshot): AudioRuntimeSnapshot {
  return snapshot
}

function registerIpcHandlers(
  settings: ApplicationSettingsStore,
  projects: ProjectService,
  recordings: RecordingService,
  operations: OperationService,
  waveforms: WaveformService,
  mixer: MixerService,
  plugins: PluginCatalogService,
  midiImport: MidiImportService,
  lifecycle: LifecycleCoordinator
): void {
  plugins.subscribe((scanEvent) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.pluginsScanEvent, scanEvent)
    }
  })
  const synchronizePluginStates = async (): Promise<void> => {
    if (!audioHostService) return
    const graph = await mixer.snapshot()
    const states = []
    for (const plugin of graph.plugins) {
      try {
        await audioHostService.loadPlugin(plugin, graph.sampleRate)
        const state = await audioHostService.savePluginState(plugin.id)
        states.push({
          id: plugin.id,
          componentState: state.componentState,
          controllerState: state.controllerState
        })
      } catch (error) {
        console.error(`Could not synchronize VST3 state for ${plugin.id}:`, error)
      }
    }
    if (states.length > 0) await projects.savePluginStates(states)
  }
  ipcMain.handle(IPC_CHANNELS.engineInfo, (event) => {
    assertTrustedSender(event)
    return engineInfo()
  })

  ipcMain.handle(IPC_CHANNELS.applicationWindowCommand, (event, value: unknown) => {
    assertTrustedSender(event)
    const command = validateApplicationWindowCommand(value)
    const window = BrowserWindow.fromWebContents(event.sender)
    switch (command) {
      case "edit.undo":
        event.sender.undo()
        break
      case "edit.redo":
        event.sender.redo()
        break
      case "edit.cut":
        event.sender.cut()
        break
      case "edit.copy":
        event.sender.copy()
        break
      case "edit.paste":
        event.sender.paste()
        break
      case "edit.select-all":
        event.sender.selectAll()
        break
      case "window.minimize":
        window?.minimize()
        break
      case "window.toggle-maximize":
        if (window?.isMaximized()) window.unmaximize()
        else window?.maximize()
        break
      case "window.close":
        window?.close()
        break
      case "view.toggle-full-screen":
        if (window) window.setFullScreen(!window.isFullScreen())
        break
      case "application.about":
        app.showAboutPanel()
        break
    }
  })

  ipcMain.handle(IPC_CHANNELS.applicationWindowTheme, (event, value: unknown) => {
    assertTrustedSender(event)
    if (value !== "light" && value !== "dark") {
      throw new TypeError("Unknown application window theme")
    }
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || process.platform !== "linux") return
    window.setTitleBarOverlay({
      color: value === "dark" ? "#151515" : "#d8d9db",
      symbolColor: value === "dark" ? "#e8e8e8" : "#202224",
      height: 38
    })
  })

  ipcMain.handle(IPC_CHANNELS.processGain, (event, value: unknown) => {
    assertTrustedSender(event)
    const request = validateGainRequest(value)
    return processGain(request.samples, request.gain)
  })

  ipcMain.handle(IPC_CHANNELS.audioBackends, async (event) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    return audioHostService.listAudioBackends()
  })

  ipcMain.handle(IPC_CHANNELS.audioDevices, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    return normalizeAudioDeviceList(
      await audioHostService.listAudioDevices(validateAudioBackend(value))
    )
  })

  ipcMain.handle(IPC_CHANNELS.audioStart, async (event, value: unknown) => {
    assertTrustedSender(event)
    const transition =
      lifecycle.snapshot().audio.status === "running" ? "reconfiguring" : "starting"
    lifecycle.beginAudio(transition)
    try {
      if (!audioHostService) throw new Error("Audio host is not running")
      const snapshot = normalizeAudioRuntime(
        await audioHostService.startAudioEngine(validateAudioPreferences(value))
      )
      if (projects.current) await mixer.load()
      lifecycle.completeAudio(snapshot)
      return snapshot
    } catch (error) {
      const snapshot = audioHostService
        ? await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
        : lifecycle.snapshot().audio.runtime
      lifecycle.failAudio(error, normalizeAudioRuntime(snapshot))
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.audioStop, async (event) => {
    assertTrustedSender(event)
    lifecycle.beginAudio("stopping")
    try {
      if (!audioHostService) throw new Error("Audio host is not running")
      const snapshot = normalizeAudioRuntime(await audioHostService.stopAudioEngine())
      lifecycle.completeAudio(snapshot)
      return snapshot
    } catch (error) {
      const snapshot = audioHostService
        ? await audioHostService
            .audioEngineSnapshot()
            .catch(() => lifecycle.snapshot().audio.runtime)
        : lifecycle.snapshot().audio.runtime
      lifecycle.failAudio(error, normalizeAudioRuntime(snapshot))
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.audioSnapshot, async (event) => {
    assertTrustedSender(event)
    if (shutdownPromise) return lifecycle.snapshot().audio.runtime
    if (!audioHostService) throw new Error("Audio host is not running")
    const snapshot = normalizeAudioRuntime(await audioHostService.audioEngineSnapshot())
    lifecycle.refreshAudio(snapshot)
    return snapshot
  })

  ipcMain.handle(IPC_CHANNELS.mixerLoad, (event) => {
    assertTrustedSender(event)
    lifecycle.assertMixerLoadAllowed()
    return mixer.snapshot()
  })

  ipcMain.handle(IPC_CHANNELS.mixerReload, (event) => {
    assertTrustedSender(event)
    lifecycle.assertMixerLoadAllowed()
    return mixer.load()
  })

  ipcMain.handle(IPC_CHANNELS.mixerExecute, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      throw new TypeError("Project command must be an object with a type")
    }
    const command = value as ProjectCommand
    lifecycle.assertMixerCommandAllowed(command)
    const result = await mixer.execute(command)
    lifecycle.syncProject(projects.current)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.mixerPreview, (event, value: unknown) => {
    assertTrustedSender(event)
    if (!value || typeof value !== "object") throw new TypeError("Mixer preview must be an object")
    lifecycle.assertMixerPreviewAllowed()
    return mixer.preview(value as MixerParameterPreview)
  })

  ipcMain.handle(IPC_CHANNELS.mixerSnapshot, (event) => {
    assertTrustedSender(event)
    if (shutdownPromise) return { meters: [], capturedAt: Date.now() }
    return mixer.runtimeSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.mixerClearMeterClips, (event) => {
    assertTrustedSender(event)
    return mixer.clearMeterClips()
  })

  ipcMain.handle(IPC_CHANNELS.pluginsList, (event) => {
    assertTrustedSender(event)
    return plugins.list()
  })

  ipcMain.handle(IPC_CHANNELS.pluginsScan, (event, value: unknown) => {
    assertTrustedSender(event)
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      throw new TypeError("Plugin scan request must be an object")
    }
    return plugins.scan(value ?? {})
  })

  ipcMain.handle(IPC_CHANNELS.pluginEditorOpen, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value) throw new TypeError("Plugin instance ID is required")
    return plugins.openEditor(value)
  })

  ipcMain.handle(IPC_CHANNELS.pluginEditorClose, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value) throw new TypeError("Plugin instance ID is required")
    return plugins.closeEditor(value)
  })

  ipcMain.handle(IPC_CHANNELS.pluginParametersGet, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value) throw new TypeError("Plugin instance ID is required")
    return plugins.parameters(value)
  })

  ipcMain.handle(IPC_CHANNELS.pluginParameterSet, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "object" || value === null) {
      throw new TypeError("Plugin parameter change must be an object")
    }
    void plugins.setParameter(value as PluginParameterChange)
  })

  ipcMain.handle(IPC_CHANNELS.midiImportPrepare, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.assertProjectWriteAllowed()
    let path = typeof value === "string" && value.trim() ? value : undefined
    if (!path) {
      const result = await dialog.showOpenDialog({
        title: "Import Standard MIDI File",
        properties: ["openFile"],
        filters: [{ name: "Standard MIDI File", extensions: ["mid", "midi"] }]
      })
      path = result.filePaths[0]
      if (result.canceled || !path) return null
    }
    return midiImport.prepare(path)
  })

  ipcMain.handle(IPC_CHANNELS.midiImportCommit, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.assertProjectWriteAllowed()
    if (typeof value !== "object" || value === null) {
      throw new TypeError("MIDI import plan must be an object")
    }
    const result = await midiImport.commit(value as MidiImportPlan)
    lifecycle.syncProject(projects.current)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.transportCommand, (event, value: unknown) => {
    assertTrustedSender(event)
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      throw new TypeError("Transport command must be an object with a type")
    }
    const command = value as TransportCommand
    lifecycle.assertTransportAllowed(command)
    if (shutdownPromise) {
      return {
        state: "stopped" as const,
        positionFrames: 0,
        sampleRate: lifecycle.snapshot().audio.runtime.sampleRate ?? 0
      }
    }
    return mixer.transport(command)
  })

  ipcMain.handle(IPC_CHANNELS.transportSnapshot, (event) => {
    assertTrustedSender(event)
    if (shutdownPromise) {
      return {
        state: "stopped" as const,
        positionFrames: 0,
        sampleRate: lifecycle.snapshot().audio.runtime.sampleRate ?? 0
      }
    }
    return mixer.transportSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.lifecycleSnapshot, (event) => {
    assertTrustedSender(event)
    return lifecycle.snapshot()
  })

  ipcMain.handle(IPC_CHANNELS.systemPerformanceSnapshot, (event) => {
    assertTrustedSender(event)
    return sampleSystemPerformance(settings)
  })

  ipcMain.handle(IPC_CHANNELS.audioBenchmarkRun, (event) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    return createAudioBenchmarkReport(audioHostService)
  })

  ipcMain.handle(IPC_CHANNELS.settingsGet, (event) => {
    assertTrustedSender(event)
    return settings.get()
  })

  ipcMain.handle(IPC_CHANNELS.settingsUpdate, (event, value: unknown) => {
    assertTrustedSender(event)
    return settings.update(validateSettingsPatch(value))
  })

  ipcMain.handle(IPC_CHANNELS.settingsConfigureAudioHostRuntime, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (
      recordings.current ||
      operations.activeCount > 0 ||
      audioHostService?.configurationRestarting
    ) {
      throw new Error("Audio host runtime configuration is busy")
    }
    if (!audioHostService) throw new Error("Audio host is not running")
    const preferences = validateAudioHostRuntimePreferences(
      value
    ) satisfies AudioHostRuntimePreferences
    await synchronizePluginStates()
    await audioHostService.configureRuntime(preferences)
    return settings.configureAudioHostRuntime(preferences)
  })

  ipcMain.handle(IPC_CHANNELS.settingsChooseSwap, async (event) => {
    assertTrustedSender(event)
    const current = await settings.get()
    const result = await dialog.showOpenDialog({
      title: "Choose recording swap directory",
      defaultPath: current.swapDirectory,
      properties: ["openDirectory", "createDirectory"]
    })
    return result.canceled || !result.filePaths[0]
      ? current
      : settings.update({ swapDirectory: result.filePaths[0] })
  })

  ipcMain.handle(IPC_CHANNELS.settingsOpenSwap, async (event) => {
    assertTrustedSender(event)
    const current = await settings.get()
    const error = await shell.openPath(current.swapDirectory)
    if (error) throw new Error(error)
  })

  ipcMain.handle(IPC_CHANNELS.projectCreate, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.beginProject("creating")
    try {
      const request = validateCreateProject(value)
      let path = request.path
      path ??= process.env.YADAW_TEST_PROJECT_PATH
      if (!path) {
        const result = await dialog.showSaveDialog({
          title: "Create YADAW project",
          defaultPath: `${request.name}.yadaw`,
          filters: [{ name: "YADAW project", extensions: ["yadaw"] }]
        })
        if (result.canceled || !result.filePath) {
          lifecycle.cancelProject()
          throw new Error("Project creation cancelled")
        }
        path = result.filePath
      }
      const created = await projects.create({ ...request, path })
      const graph = await mixer.load()
      const assets = await projects.listAssets()
      lifecycle.completeProject(created)
      return { session: created, graph, assets }
    } catch (error) {
      try {
        await projects.abortOpen()
      } catch {
        // Preserve the original create failure; shutdown will terminate a stuck worker.
      }
      if (lifecycle.snapshot().project.status === "creating") lifecycle.failProject(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectPrepareOpen, async (event, value: unknown) => {
    assertTrustedSender(event)
    let path = typeof value === "string" && value.trim() ? value : undefined
    if (!path) {
      const result = await dialog.showOpenDialog({
        title: "Open YADAW project",
        properties: ["openFile"],
        filters: [{ name: "YADAW project", extensions: ["yadaw"] }]
      })
      path = result.filePaths[0]
      if (result.canceled || !path) return null
    }
    return {
      path,
      recoverableWorkingCopy: await projects.hasRecoverableWorkingCopy(path)
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectOpen, async (event, value: unknown, recoverValue: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value.trim()) {
      throw new TypeError("Project path must be a non-empty string")
    }
    if (recoverValue !== undefined && typeof recoverValue !== "boolean") {
      throw new TypeError("Project recovery choice must be a boolean")
    }
    const path = value
    const recover = recoverValue === true
    lifecycle.beginProject("opening")
    try {
      const operationId = "open-project"
      const projectName = basename(path).replace(/\.yadaw$/i, "")
      operations.upsert(
        {
          id: operationId,
          title: "Opening project",
          description: projectName,
          phase: recover ? "loading-project-database" : "loading-project-archive",
          state: "running",
          completedUnits: 0,
          totalUnits: 5,
          cancellable: false,
          message: null,
          dropoutFrames: 0
        },
        true
      )
      const opened = await projects.open(path, recover, ({ phase, completedUnits }) => {
        operations.patch(operationId, { phase, completedUnits }, true)
      })
      operations.patch(
        operationId,
        {
          phase: "loading-mixer",
          completedUnits: 2
        },
        true
      )
      const graph = await mixer.load()
      operations.patch(
        operationId,
        {
          phase: "loading-project-assets",
          completedUnits: 3
        },
        true
      )
      const assets = await projects.listAssets()
      operations.patch(
        operationId,
        {
          phase: "preparing-waveforms",
          completedUnits: 4
        },
        true
      )
      await waveforms.prepareMissing()
      operations.patch(
        operationId,
        {
          state: "completed",
          completedUnits: 5
        },
        true
      )
      lifecycle.completeProject(opened)
      operations.remove(operationId)
      return { session: opened, graph, assets }
    } catch (error) {
      try {
        await projects.abortOpen()
      } catch {
        // Preserve the original open failure; shutdown will terminate a stuck worker.
      }
      lifecycle.failProject(error)
      const activeOperation = lifecycle.snapshot().project.status === "closed"
      if (activeOperation) {
        try {
          operations.patch(
            "open-project",
            {
              state: "failed",
              message: error instanceof Error ? error.message : String(error)
            },
            true
          )
        } catch {
          // The file chooser or recovery prompt may have failed before the operation existed.
        }
      }
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectSave, async (event, value: unknown) => {
    assertTrustedSender(event)
    const current = projects.current
    if (!current) return null
    lifecycle.beginProject("saving")
    const operationId = `save:${current.id}`
    operations.upsert(
      {
        id: operationId,
        title: "Saving project",
        description: current.configuration.name,
        phase: "saving-archive",
        state: "running",
        completedUnits: null,
        totalUnits: null,
        cancellable: false,
        message: null,
        dropoutFrames: 0
      },
      true
    )
    try {
      await synchronizePluginStates()
      const saved = await projects.save(typeof value === "string" ? value : undefined)
      operations.patch(operationId, { phase: "cleaning-up" }, true)
      await recordings.cleanupCommittedForProject(saved.path)
      operations.patch(operationId, { state: "completed" }, true)
      lifecycle.completeProject(saved)
      return saved
    } catch (error) {
      lifecycle.failProject(error)
      operations.patch(
        operationId,
        {
          state: "failed",
          message: error instanceof Error ? error.message : String(error)
        },
        true
      )
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectClose, async (event, value: unknown) => {
    assertTrustedSender(event)
    const current = projects.current
    if (!current) return true
    lifecycle.beginProject("closing")
    try {
      let disposition = value as ProjectCloseDisposition | undefined
      if (current.dirty && !disposition) {
        lifecycle.cancelProject()
        return false
      }
      disposition ??= "discard"
      if (disposition !== "save" && disposition !== "discard" && disposition !== "cancel") {
        throw new TypeError("Invalid close disposition")
      }
      if (disposition === "save") await synchronizePluginStates()
      const closed = await projects.close(disposition)
      if (!closed) {
        lifecycle.cancelProject()
        return false
      }
      try {
        await mixer.transport({ type: "stop" })
      } catch {
        // The audio engine may already be stopped.
      }
      if (disposition === "save") await recordings.cleanupCommittedForProject(current.path)
      lifecycle.completeProject(null)
      return true
    } catch (error) {
      lifecycle.failProject(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.projectAssetsList, async (event) => {
    assertTrustedSender(event)
    return projects.listAssets()
  })

  ipcMain.handle(IPC_CHANNELS.projectConfigurationUpdate, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.assertProjectWriteAllowed()
    const session = await projects.updateConfiguration(validateProjectConfiguration(value))
    lifecycle.syncProject(session)
    return session
  })

  ipcMain.handle(IPC_CHANNELS.recordingStart, async (event) => {
    assertTrustedSender(event)
    lifecycle.beginRecordingStart()
    try {
      const session = await recordings.start()
      lifecycle.completeRecordingStart(session)
      return session
    } catch (error) {
      lifecycle.failRecordingStart(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.recordingStop, async (event) => {
    assertTrustedSender(event)
    const session = lifecycle.beginRecordingStop()
    try {
      const completed = await recordings.stop(() => lifecycle.markRecordingFinalizing(session))
      lifecycle.completeRecordingStop()
      lifecycle.syncProject(projects.current)
      return completed
    } catch (error) {
      lifecycle.failRecordingStop(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.recordingPendingList, (event) => {
    assertTrustedSender(event)
    return recordings.listPending()
  })

  ipcMain.handle(IPC_CHANNELS.recordingRecover, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string") throw new TypeError("Recording id must be a string")
    lifecycle.beginRecordingRecovery(value)
    try {
      await recordings.recover(value)
      lifecycle.completeRecordingRecovery()
      lifecycle.syncProject(projects.current)
    } catch (error) {
      lifecycle.failRecordingRecovery(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.recordingDeletePending, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string") throw new TypeError("Recording id must be a string")
    lifecycle.assertRecordingIdle()
    return recordings.deletePending(value)
  })

  ipcMain.handle(IPC_CHANNELS.assetAudioRead, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new TypeError("Audio asset id must be a non-empty string")
    }
    return projects.readAssetAudio(value)
  })

  ipcMain.handle(IPC_CHANNELS.assetWaveformRead, (event, value: unknown) => {
    assertTrustedSender(event)
    return waveforms.readAsset(validateWaveformRequest(value))
  })

  ipcMain.handle(IPC_CHANNELS.recordingWaveformSnapshot, (event, value: unknown) => {
    assertTrustedSender(event)
    return recordings.waveformSnapshot(validateWaveformRequest(value))
  })

  ipcMain.handle(IPC_CHANNELS.operationCancel, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string") throw new TypeError("Operation id must be a string")
    return operations.cancel(value)
  })
}

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null

function loadMainWindow(window: BrowserWindow): void {
  if (process.env.YADAW_RENDERER_URL) {
    void window.loadURL(process.env.YADAW_RENDERER_URL)
  } else {
    void window.loadFile(join(rendererDirectory, "index.html"))
  }
}

function loadSplashWindow(window: BrowserWindow): void {
  if (process.env.YADAW_RENDERER_URL) {
    void window.loadURL(new URL("splash.html", process.env.YADAW_RENDERER_URL).toString())
  } else {
    void window.loadFile(join(rendererDirectory, "splash.html"))
  }
}

function createSplashWindow(): BrowserWindow {
  const window = new BrowserWindow({
    show: false,
    width: 620,
    height: 360,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    transparent: false,
    backgroundColor: "#0b0e13",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  splashWindow = window
  window.once("closed", () => {
    if (splashWindow === window) splashWindow = null
  })
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })
  loadSplashWindow(window)
  return window
}

function createMainWindow(loadContent = true): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  const isMacOS = process.platform === "darwin"
  const usesWindowControlsOverlay = process.platform === "linux"
  const window = new BrowserWindow({
    show: loadContent,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0e13",
    titleBarStyle: isMacOS ? "hiddenInset" : "hidden",
    ...(isMacOS
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : usesWindowControlsOverlay
        ? {
            titleBarOverlay: {
              color: "#151515",
              symbolColor: "#e8e8e8",
              height: 38
            }
          }
        : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault()
    }
  })
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("YADAW renderer process exited", details)
  })
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("YADAW renderer failed to load", { code, description })
  })

  if (loadContent) loadMainWindow(window)

  return window
}

let projectService: ProjectService | null = null
let audioHostService: AudioHostService | null = null
let shutdownComplete = false
let shutdownPromise: Promise<void> | null = null

async function shutdownServices(): Promise<void> {
  await Promise.allSettled([
    (async () => {
      const service = audioHostService
      if (!service) return
      try {
        await service.stopAudioEngine()
      } catch {
        // The helper may already be stopping or unavailable.
      }
      await service.stop()
    })(),
    projectService?.shutdown()
  ])
}

void app.whenReady().then(async () => {
  const startup = new StartupProgress()
  ipcMain.handle(IPC_CHANNELS.startupProgressSnapshot, (event) => {
    assertTrustedSender(event)
    return startup.snapshot()
  })
  startup.subscribe((progress) => {
    const window = splashWindow
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.startupProgressEvent, progress)
    }
  })
  createSplashWindow()

  try {
    startup.update({
      phase: "loading-catalog",
      progress: 0.05,
      label: "Loading plug-in catalog",
      detail: "Reading settings and built-in VST3 modules"
    })
    const settings = new ApplicationSettingsStore(app.getPath("userData"))
    const applicationSettings = await settings.get()
    const executableSuffix = process.platform === "win32" ? ".exe" : ""
    const probePath = app.isPackaged
      ? join(process.resourcesPath, `yadaw-vst3-probe${executableSuffix}`)
      : resolve(
          app.getAppPath(),
          "..",
          "..",
          "target",
          "debug",
          `yadaw-vst3-probe${executableSuffix}`
        )
    const builtinPluginDirectory = app.isPackaged
      ? join(process.resourcesPath, "plugins")
      : resolve(app.getAppPath(), "..", "..", "target", "bundles")
    const plugins = new PluginCatalogService(
      app.getPath("userData"),
      probePath,
      builtinPluginDirectory
    )
    await plugins.initialize()

    let scanTotal = 0
    let scanWarnings = 0
    const unsubscribeScan = plugins.subscribe((event) => {
      if (event.type === "started") {
        scanTotal = event.total
        startup.update({
          phase: "scanning-plugins",
          progress: 0.16,
          label: "Scanning VST3 plug-ins",
          detail:
            event.total === 0
              ? "No external VST3 bundles found"
              : `Found ${event.total} VST3 bundles`,
          completed: 0,
          total: event.total
        })
      } else if (event.type === "progress") {
        const ratio = event.total > 0 ? event.completed / event.total : 1
        startup.update({
          phase: "scanning-plugins",
          progress: 0.18 + ratio * 0.58,
          label: "Scanning VST3 plug-ins",
          detail: basename(event.path),
          completed: event.completed,
          total: event.total
        })
      } else if (event.type === "quarantined") {
        scanWarnings += 1
        startup.update({
          detail: `${basename(event.path)} could not be loaded`,
          warnings: scanWarnings
        })
      } else {
        startup.update({
          progress: 0.78,
          detail: `${event.catalog.plugins.length} VST3 plug-ins available`,
          completed: scanTotal,
          total: scanTotal
        })
      }
    })
    startup.update({
      phase: "scanning-plugins",
      progress: 0.12,
      label: "Discovering VST3 plug-ins",
      detail: "Searching system and user plug-in folders"
    })
    try {
      await plugins.scan({ force: true, retryQuarantined: true })
    } catch (error) {
      scanWarnings += 1
      startup.update({
        progress: 0.78,
        detail:
          error instanceof Error
            ? `VST3 scan finished with an error: ${error.message}`
            : "VST3 scan finished with an unknown error",
        warnings: scanWarnings
      })
      console.error("Startup VST3 scan failed:", error)
    } finally {
      unsubscribeScan()
    }

    startup.update({
      phase: "starting-audio",
      progress: 0.82,
      label: "Starting audio services",
      detail: "Connecting the isolated audio engine",
      completed: null,
      total: null
    })
    const audioHostPath = app.isPackaged
      ? join(process.resourcesPath, `yadaw-audio-host${executableSuffix}`)
      : resolve(
          app.getAppPath(),
          "..",
          "..",
          "target",
          "debug",
          `yadaw-audio-host${executableSuffix}`
        )
    const window = createMainWindow(false)
    audioHostService = new AudioHostService(
      audioHostPath,
      join(app.getPath("userData"), "audio-host-crash-marker.bin"),
      applicationSettings.audioHostRuntime,
      process.platform === "win32" ? window.getNativeWindowHandle() : undefined,
      (message) => {
        console.error(`YADAW audio helper failure: ${message}`)
        for (const candidate of BrowserWindow.getAllWindows()) {
          if (candidate !== mainWindow && candidate !== splashWindow) candidate.close()
        }
      },
      async (classId, preference) => {
        await settings.setPluginEditorPreference(classId, preference)
      }
    )
    audioHostService.start()
    projectService = new ProjectService(app.getPath("userData"), settings)
    const operations = new OperationService()
    const mixer = new MixerService(
      app.getPath("userData"),
      projectService,
      audioHostService,
      plugins
    )
    plugins.attachRuntime({
      resolveInstance: async (instanceId) => {
        const graph = await mixer.snapshot()
        const plugin = graph.plugins.find((candidate) => candidate.id === instanceId)
        if (!plugin) throw new Error(`Plugin instance '${instanceId}' was not found`)
        return { plugin, sampleRate: graph.sampleRate }
      },
      load: (plugin, sampleRate) => {
        if (!audioHostService) return Promise.reject(new Error("Audio host is not running"))
        return audioHostService.loadPlugin(plugin, sampleRate)
      },
      parameters: (instanceId) => {
        if (!audioHostService) return Promise.resolve([])
        return audioHostService.pluginParameters(instanceId)
      },
      setParameter: (change) => {
        if (!audioHostService) return Promise.reject(new Error("Audio host is not running"))
        return audioHostService.setPluginParameter(change)
      },
      openEditor: async (instanceId) => {
        if (!audioHostService) {
          return { editorMode: "parameters" as const, open: false }
        }
        const graph = await mixer.snapshot()
        const plugin = graph.plugins.find((candidate) => candidate.id === instanceId)
        if (!plugin) throw new Error(`Plugin instance '${instanceId}' was not found`)
        const preference = await settings.pluginEditorPreference(plugin.classId)
        return audioHostService.openPluginEditor(instanceId, preference)
      },
      closeEditor: (instanceId) => {
        if (!audioHostService) return Promise.resolve()
        return audioHostService.closePluginEditor(instanceId)
      }
    })
    const midiImport = new MidiImportService(mixer, plugins)
    const recordings = new RecordingService(
      settings,
      projectService,
      operations,
      mixer,
      audioHostService
    )
    const waveforms = new WaveformService(settings, projectService)
    const initialAudioRuntime = await audioHostService.audioEngineSnapshot()
    const lifecycle = new LifecycleCoordinator(
      projectService.current,
      normalizeAudioRuntime(initialAudioRuntime),
      { allowRecordingWithoutAudio: process.env.YADAW_TEST_CAPTURE_SOURCE === "1" }
    )
    registerIpcHandlers(
      settings,
      projectService,
      recordings,
      operations,
      waveforms,
      mixer,
      plugins,
      midiImport,
      lifecycle
    )
    startup.update({
      phase: "opening-workspace",
      progress: 0.94,
      label: "Opening workspace",
      detail: "Building the mixer and project interface"
    })
    window.once("ready-to-show", () => {
      startup.complete(`${plugins.list().plugins.length} VST3 plug-ins ready`)
      if (!window.isDestroyed()) window.show()
      setTimeout(() => {
        const splash = splashWindow
        if (splash && !splash.isDestroyed()) splash.close()
      }, 220)
    })
    loadMainWindow(window)
    installApplicationMenu()

    app.on("activate", () => {
      if (!mainWindow || mainWindow.isDestroyed()) {
        createMainWindow()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (error) {
    console.error("YADAW startup failed:", error)
    startup.fail(error)
    setTimeout(() => app.quit(), 4_000).unref()
  }
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", (event) => {
  if (shutdownComplete) return
  event.preventDefault()
  if (shutdownPromise) return
  shutdownPromise = shutdownServices().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})

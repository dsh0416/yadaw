import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { statfs } from "node:fs/promises"
import { cpus, freemem, totalmem } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AUDIO_BACKENDS, IPC_CHANNELS } from "@yadaw/contracts"
import type {
  AudioBackend,
  AudioDeviceList,
  AudioPreferences,
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
  PluginScanRequest,
  TransportCommand,
  StorageSpaceSnapshot,
  SystemPerformanceSnapshot,
  WaveformWindowRequest
} from "@yadaw/contracts"
import {
  engineInfo,
  processGain
} from "@yadaw/dsp-node"
import { ApplicationSettingsStore } from "./application-settings"
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
import { WaveformService } from "./waveform-service"

const rendererDirectory = join(import.meta.dirname, "../renderer")

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
  return Math.min(100, Math.max(0, numerator / denominator * 100))
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
      usagePercent: prior && totalDelta > 0
        ? percentage(totalDelta - idleDelta, totalDelta)
        : null
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
    overallUsagePercent: totals.total > 0
      ? percentage(totals.total - totals.idle, totals.total)
      : null,
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

async function sampleSystemPerformance(settings: ApplicationSettingsStore): Promise<SystemPerformanceSnapshot> {
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
  if (typeof value !== "object" || value === null) throw new TypeError("Project options must be an object")
  const request = value as CreateProjectRequest
  if (typeof request.name !== "string" || typeof request.sampleRate !== "number" ||
      typeof request.timeSignatureNumerator !== "number" ||
      typeof request.timeSignatureDenominator !== "number" ||
      (request.waveformDisplayMode !== "separate" && request.waveformDisplayMode !== "aggregate") ||
      (request.path !== undefined && typeof request.path !== "string")) {
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
  if (typeof value !== "object" || value === null) throw new TypeError("Waveform request must be an object")
  const request = value as WaveformWindowRequest
  if (
    typeof request.id !== "string" || request.id.length === 0 || request.id.length > 256 ||
    !Number.isSafeInteger(request.startFrame) || request.startFrame < 0 ||
    !Number.isSafeInteger(request.endFrame) || request.endFrame < request.startFrame ||
    !Number.isInteger(request.maxBuckets) ||
    request.maxBuckets < 1 || request.maxBuckets > 4_096
  ) throw new TypeError("Invalid waveform request")
  return request
}

function validateSettingsPatch(value: unknown): ApplicationSettingsPatch {
  if (typeof value !== "object" || value === null) throw new TypeError("Settings patch must be an object")
  const patch = value as ApplicationSettingsPatch
  if (patch.swapDirectory !== undefined && typeof patch.swapDirectory !== "string") {
    throw new TypeError("Swap directory must be a string")
  }
  if (patch.recordingBitDepth !== undefined &&
      patch.recordingBitDepth !== "float32" && patch.recordingBitDepth !== "pcm24" && patch.recordingBitDepth !== "pcm16") {
    throw new TypeError("Unsupported recording bit depth")
  }
  if (patch.theme !== undefined &&
      patch.theme !== "light" && patch.theme !== "dark" && patch.theme !== "system") {
    throw new TypeError("Unsupported theme preference")
  }
  if (patch.meterPeakHold !== undefined &&
      patch.meterPeakHold !== "800ms" && patch.meterPeakHold !== "2s" &&
      patch.meterPeakHold !== "4s" && patch.meterPeakHold !== "infinite") {
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
  if (typeof value !== "string" || !AUDIO_BACKENDS.includes(value as AudioBackend)) {
    throw new TypeError("Unknown audio backend")
  }

  return value as AudioBackend
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
    bufferSize: preferences.bufferSize as AudioPreferences["bufferSize"]
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
    const transition = lifecycle.snapshot().audio.status === "running"
      ? "reconfiguring"
      : "starting"
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
        ? await audioHostService.audioEngineSnapshot().catch(() => lifecycle.snapshot().audio.runtime)
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
        ? await audioHostService.audioEngineSnapshot().catch(() => lifecycle.snapshot().audio.runtime)
        : lifecycle.snapshot().audio.runtime
      lifecycle.failAudio(error, normalizeAudioRuntime(snapshot))
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.audioSnapshot, async (event) => {
    assertTrustedSender(event)
    if (!audioHostService) throw new Error("Audio host is not running")
    const snapshot = normalizeAudioRuntime(await audioHostService.audioEngineSnapshot())
    lifecycle.refreshAudio(snapshot)
    return snapshot
  })

  ipcMain.handle(IPC_CHANNELS.mixerLoad, (event) => {
    assertTrustedSender(event)
    lifecycle.assertMixerLoadAllowed()
    return mixer.load()
  })

  ipcMain.handle(IPC_CHANNELS.mixerExecute, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
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
    return plugins.scan((value ?? {}) as PluginScanRequest)
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
    plugins.setParameter(value as PluginParameterChange)
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
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
      throw new TypeError("Transport command must be an object with a type")
    }
    const command = value as TransportCommand
    lifecycle.assertTransportAllowed(command)
    return mixer.transport(command)
  })

  ipcMain.handle(IPC_CHANNELS.transportSnapshot, (event) => {
    assertTrustedSender(event)
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
      await mixer.load()
      lifecycle.completeProject(created)
      return created
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

  ipcMain.handle(IPC_CHANNELS.projectOpen, async (
    event,
    value: unknown,
    recoverValue: unknown
  ) => {
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
      operations.upsert({
        id: operationId,
        title: `Opening ${projectName}`,
        phase: recover ? "loading-project-database" : "loading-project-archive",
        state: "running",
        completedUnits: 0,
        totalUnits: 4,
        cancellable: false,
        message: null,
        dropoutFrames: 0
      }, true)
      const opened = await projects.open(path, recover, ({ phase, completedUnits }) => {
        operations.patch(operationId, { phase, completedUnits }, true)
      })
      operations.patch(operationId, {
        phase: "loading-mixer",
        completedUnits: 2
      }, true)
      await mixer.load()
      operations.patch(operationId, {
        phase: "preparing-waveforms",
        completedUnits: 3
      }, true)
      waveforms.rebuildMissingInBackground()
      operations.patch(operationId, {
        state: "completed",
        completedUnits: 4
      }, true)
      lifecycle.completeProject(opened)
      return opened
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
          operations.patch("open-project", {
            state: "failed",
            message: error instanceof Error ? error.message : String(error)
          }, true)
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
    operations.upsert({
      id: operationId,
      title: `Saving ${current.configuration.name}`,
      phase: "saving-archive",
      state: "running",
      completedUnits: null,
      totalUnits: null,
      cancellable: false,
      message: null,
      dropoutFrames: 0
    }, true)
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
      operations.patch(operationId, {
        state: "failed",
        message: error instanceof Error ? error.message : String(error)
      }, true)
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

function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0e13",
    titleBarStyle: "hiddenInset",
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

  if (process.env.YADAW_RENDERER_URL) {
    void window.loadURL(process.env.YADAW_RENDERER_URL)
  } else {
    void window.loadFile(join(rendererDirectory, "index.html"))
  }

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

app.whenReady().then(async () => {
  const settings = new ApplicationSettingsStore(app.getPath("userData"))
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
  const plugins = new PluginCatalogService(app.getPath("userData"), probePath)
  await plugins.initialize()
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
  const bridgeFilename = process.platform === "win32"
    ? "yadaw-vst3-bridge.dll"
    : process.platform === "darwin"
      ? "libyadaw-vst3-bridge.dylib"
      : "libyadaw-vst3-bridge.so"
  const bridgePath = app.isPackaged
    ? join(process.resourcesPath, bridgeFilename)
    : resolve(
        app.getAppPath(),
        "..",
        "..",
        "target",
        "vst3-bridge-build",
        "bin",
        bridgeFilename
      )
  audioHostService = new AudioHostService(
    audioHostPath,
    bridgePath,
    join(app.getPath("userData"), "audio-host-crash-marker.bin"),
    (message) => {
    console.error(`YADAW audio helper failure: ${message}`)
    for (const window of BrowserWindow.getAllWindows().slice(1)) window.close()
    }
  )
  audioHostService.start()
  projectService = new ProjectService(app.getPath("userData"), settings)
  const operations = new OperationService()
  const mixer = new MixerService(app.getPath("userData"), projectService, audioHostService)
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
    openEditor: (instanceId) => {
      if (!audioHostService) {
        return Promise.resolve({ editorKind: "generic" as const, open: false })
      }
      return audioHostService.openPluginEditor(instanceId)
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
  createMainWindow()
  installApplicationMenu()

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow()
    } else {
      mainWindow.show()
      mainWindow.focus()
    }
  })
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

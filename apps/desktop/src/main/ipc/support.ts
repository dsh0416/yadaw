import { app } from "electron"
import type { IpcMainInvokeEvent } from "electron"
import { statfs } from "node:fs/promises"
import { cpus, freemem, totalmem } from "node:os"
import { join } from "node:path"
import { APPLICATION_WINDOW_COMMAND_IDS, AUDIO_BACKENDS } from "@heron/contracts"
import type {
  ApplicationWindowCommandId,
  ApplicationSettingsPatch,
  AudioBackend,
  AudioDeviceList,
  AudioPreferences,
  AudioRuntimeSnapshot,
  CreateProjectRequest,
  ProcessGainRequest,
  ProjectConfiguration,
  RoundTripLatencyMeasurementRequest,
  StorageSpaceSnapshot,
  SystemPerformanceSnapshot,
  WaveformWindowRequest
} from "@heron/contracts"
import { isAppLocale } from "../../shared/i18n"
import { isTrustedMainRendererUrl } from "../../shared/renderer-security"
import type { ApplicationSettingsStore } from "../settings"
import type { AudioHostService } from "../audio-host"

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

export async function sampleSystemPerformance(
  settings: ApplicationSettingsStore,
  audioHostService: AudioHostService
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

export function validateCreateProject(value: unknown): CreateProjectRequest {
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

export function validateProjectConfiguration(value: unknown): ProjectConfiguration {
  const request = validateCreateProject(value)
  return {
    name: request.name,
    sampleRate: request.sampleRate,
    timeSignatureNumerator: request.timeSignatureNumerator,
    timeSignatureDenominator: request.timeSignatureDenominator,
    waveformDisplayMode: request.waveformDisplayMode
  }
}

export function validateWaveformRequest(value: unknown): WaveformWindowRequest {
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

export function validateSettingsPatch(value: unknown): ApplicationSettingsPatch {
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
  if (patch.locale !== undefined && !isAppLocale(patch.locale)) {
    throw new TypeError("Unsupported locale preference")
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
  if (
    patch.midiCenterCStandard !== undefined &&
    patch.midiCenterCStandard !== "yamaha-c3" &&
    patch.midiCenterCStandard !== "roland-c4"
  ) {
    throw new TypeError("Unsupported MIDI center C standard")
  }
  return patch
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!event.senderFrame) {
    throw new Error("Rejected IPC call without a sender frame")
  }
  if (event.senderFrame !== event.sender.mainFrame) {
    throw new Error("Rejected IPC call from a subframe")
  }

  if (
    isTrustedMainRendererUrl(event.senderFrame.url, app.isPackaged, process.env.HERON_RENDERER_URL)
  ) {
    return
  }

  throw new Error("Rejected IPC call from an untrusted renderer")
}

export function validateGainRequest(value: unknown): ProcessGainRequest {
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

export function validateAudioBackend(value: unknown): AudioBackend {
  if (typeof value !== "string" || !AUDIO_BACKENDS.includes(value as AudioBackend)) {
    throw new TypeError("Unknown audio backend")
  }

  return value as AudioBackend
}

export function validateApplicationWindowCommand(value: unknown): ApplicationWindowCommandId {
  if (
    typeof value !== "string" ||
    !APPLICATION_WINDOW_COMMAND_IDS.includes(value as ApplicationWindowCommandId)
  ) {
    throw new TypeError("Unknown application window command")
  }
  return value as ApplicationWindowCommandId
}

export function validateAudioPreferences(value: unknown): AudioPreferences {
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

export function validateRoundTripLatencyMeasurementRequest(
  value: unknown
): RoundTripLatencyMeasurementRequest {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Round-trip latency measurement request must be an object")
  }
  const request = value as Partial<RoundTripLatencyMeasurementRequest>
  const validateChannel = (label: string, channel: unknown): number => {
    if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 1 || channel > 256) {
      throw new TypeError(`Round-trip latency ${label} channel must be between 1 and 256`)
    }
    return channel
  }
  return {
    inputChannel: validateChannel("input", request.inputChannel),
    outputChannel: validateChannel("output", request.outputChannel)
  }
}

export function normalizeAudioDeviceList(devices: AudioDeviceList): AudioDeviceList {
  return devices
}

export function normalizeAudioRuntime(snapshot: AudioRuntimeSnapshot): AudioRuntimeSnapshot {
  return snapshot
}

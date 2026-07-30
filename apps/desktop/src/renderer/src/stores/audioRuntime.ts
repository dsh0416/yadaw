import { useIntervalFn } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type {
  AudioLifecycleState,
  AudioPreferences,
  AudioRuntimeSnapshot,
  RoundTripLatencyMeasurement,
  RoundTripLatencyMeasurementRequest
} from "@yadaw/contracts"
import { i18n } from "../i18n"

function t(key: string, params?: Record<string, string | number>): string {
  return i18n.global.t(key, params ?? {})
}

const POLLING_INTERVAL_MS = 500
const TELEMETRY_HISTORY_LIMIT = 240
const STARTUP_XRUN_GRACE_MS = 2_000

export type AudioWarningSeverity = "warning" | "critical"

export interface AudioWarning {
  id: string
  severity: AudioWarningSeverity
  title: string
  message: string
}

export interface AudioTelemetrySample {
  capturedAt: number
  inputLatencyMs: number | null
  outputLatencyMs: number | null
  ringBufferLatencyMs: number | null
  roundTripLatencyMs: number | null
  ringBufferFillFrames: number | null
  xruns: number
}

export interface AudioTelemetryStatistics {
  sampleCount: number
  averageRoundTripLatencyMs: number | null
  maximumRoundTripLatencyMs: number | null
  maximumOutputLatencyMs: number | null
  minimumRingBufferFillFrames: number | null
  maximumRingBufferFillFrames: number | null
  sessionXruns: number
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function maximum(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values)
}

function minimum(values: number[]): number | null {
  return values.length === 0 ? null : Math.min(...values)
}

function compact(values: Array<number | null>): number[] {
  return values.filter((value): value is number => value !== null && Number.isFinite(value))
}

function formatRate(sampleRate: number): string {
  return `${(sampleRate / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })} kHz`
}

export const useAudioRuntimeStore = defineStore("audio-runtime", () => {
  const lifecycle = shallowRef<AudioLifecycleState>({
    status: "stopped",
    runtime: { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT },
    error: null
  })
  const runtime = computed(() => lifecycle.value.runtime)
  const latencyHistory = shallowRef<AudioTelemetrySample[]>([])
  const roundTripLatencyMeasurement = shallowRef<RoundTripLatencyMeasurement>({
    status: "idle",
    inputChannel: null,
    outputChannel: null,
    measuredRoundTripLatencyMs: null,
    failure: null
  })
  const lastError = computed(() => lifecycle.value.error ?? "")
  const lastUpdatedAt = ref<number | null>(null)
  const xrunBaseline = ref(0)
  let sessionStartedAt = 0
  let requestGeneration = 0

  function record(snapshot: AudioRuntimeSnapshot, capturedAt: number): void {
    if (snapshot.state !== "running") return

    const sample: AudioTelemetrySample = {
      capturedAt,
      inputLatencyMs: snapshot.inputLatencyMs,
      outputLatencyMs: snapshot.outputLatencyMs,
      ringBufferLatencyMs: snapshot.ringBufferLatencyMs,
      roundTripLatencyMs: snapshot.estimatedRoundTripLatencyMs,
      ringBufferFillFrames: snapshot.ringBufferFillFrames,
      xruns: snapshot.xruns
    }
    latencyHistory.value = [...latencyHistory.value, sample].slice(-TELEMETRY_HISTORY_LIMIT)
  }

  function updateRuntime(snapshot: AudioRuntimeSnapshot): void {
    const capturedAt = Date.now()
    const previous = runtime.value
    const startedSession = snapshot.state === "running" && previous.state !== "running"
    const restartedCounters = snapshot.state === "running" && snapshot.xruns < previous.xruns

    if (startedSession || restartedCounters) {
      sessionStartedAt = capturedAt
      xrunBaseline.value = snapshot.xruns
    } else if (
      snapshot.state === "running" &&
      capturedAt - sessionStartedAt < STARTUP_XRUN_GRACE_MS
    ) {
      // A few callbacks can miss the pre-roll while the two CPAL streams settle.
      // Keep those startup artifacts out of the user-facing fault count.
      xrunBaseline.value = snapshot.xruns
    }

    lifecycle.value =
      snapshot.state === "running"
        ? { status: "running", runtime: snapshot, error: null }
        : snapshot.state === "error"
          ? {
              status: "error",
              runtime: snapshot,
              error: lifecycle.value.error ?? t("errors.nativeAudioEngineStopped")
            }
          : { status: "stopped", runtime: snapshot, error: null }
    lastUpdatedAt.value = capturedAt
    record(snapshot, capturedAt)
  }

  async function refresh(): Promise<void> {
    const generation = ++requestGeneration
    try {
      const snapshot = await window.yadaw.audioEngineSnapshot()
      if (generation === requestGeneration) updateRuntime(snapshot)
    } catch (error) {
      if (generation !== requestGeneration) return
      lifecycle.value = {
        status: "error",
        runtime: runtime.value,
        error: error instanceof Error ? error.message : t("errors.unableToReadAudioEngineState")
      }
    }
  }

  async function startEngine(preferences: AudioPreferences): Promise<AudioRuntimeSnapshot> {
    const generation = ++requestGeneration
    lifecycle.value = {
      status: lifecycle.value.status === "running" ? "reconfiguring" : "starting",
      runtime: runtime.value,
      error: null
    }
    try {
      const snapshot = await window.yadaw.startAudioEngine(preferences)
      if (generation === requestGeneration) updateRuntime(snapshot)
      return snapshot
    } catch (error) {
      if (generation !== requestGeneration) throw error
      lifecycle.value = {
        status: "error",
        runtime: runtime.value,
        error: error instanceof Error ? error.message : t("errors.unableToStartAudioEngine")
      }
      throw error
    }
  }

  async function stopEngine(): Promise<AudioRuntimeSnapshot> {
    const generation = ++requestGeneration
    lifecycle.value = { status: "stopping", runtime: runtime.value, error: null }
    try {
      const snapshot = await window.yadaw.stopAudioEngine()
      if (generation === requestGeneration) updateRuntime(snapshot)
      return snapshot
    } catch (error) {
      if (generation !== requestGeneration) throw error
      lifecycle.value = {
        status: "error",
        runtime: runtime.value,
        error: error instanceof Error ? error.message : t("errors.unableToStopAudioEngine")
      }
      throw error
    }
  }

  async function startRoundTripLatencyMeasurement(
    request: RoundTripLatencyMeasurementRequest
  ): Promise<RoundTripLatencyMeasurement> {
    const measurement = await window.yadaw.startRoundTripLatencyMeasurement(request)
    roundTripLatencyMeasurement.value = measurement
    return measurement
  }

  async function refreshRoundTripLatencyMeasurement(): Promise<RoundTripLatencyMeasurement> {
    const measurement = await window.yadaw.roundTripLatencyMeasurementSnapshot()
    roundTripLatencyMeasurement.value = measurement
    return measurement
  }

  function applyLifecycleState(state: AudioLifecycleState): void {
    requestGeneration += 1
    const accepted = structuredClone(state)
    updateRuntime(accepted.runtime)
    lifecycle.value = accepted
  }

  const polling = useIntervalFn(() => void refresh(), POLLING_INTERVAL_MS, { immediate: false })

  function startPolling(): void {
    void refresh()
    polling.resume()
  }

  function stopPolling(): void {
    polling.pause()
  }

  const sessionXruns = computed(() => Math.max(0, runtime.value.xruns - xrunBaseline.value))

  const statistics = computed<AudioTelemetryStatistics>(() => {
    const roundTrip = compact(latencyHistory.value.map((sample) => sample.roundTripLatencyMs))
    const output = compact(latencyHistory.value.map((sample) => sample.outputLatencyMs))
    const ringFill = compact(latencyHistory.value.map((sample) => sample.ringBufferFillFrames))

    return {
      sampleCount: latencyHistory.value.length,
      averageRoundTripLatencyMs: average(roundTrip),
      maximumRoundTripLatencyMs: maximum(roundTrip),
      maximumOutputLatencyMs: maximum(output),
      minimumRingBufferFillFrames: minimum(ringFill),
      maximumRingBufferFillFrames: maximum(ringFill),
      sessionXruns: sessionXruns.value
    }
  })

  const warnings = computed<AudioWarning[]>(() => {
    const snapshot = runtime.value
    const result: AudioWarning[] = []

    if (lastError.value) {
      result.push({
        id: "native-error",
        severity: "critical",
        title: t("warnings.audio.nativeError.title"),
        message: lastError.value
      })
    } else if (snapshot.state === "error") {
      result.push({
        id: "engine-error",
        severity: "critical",
        title: t("warnings.audio.engineStopped.title"),
        message: t("warnings.audio.engineStopped.message")
      })
    }

    if (snapshot.state !== "running") return result

    if (snapshot.bufferFallback) {
      const actual = snapshot.outputBufferSize ?? snapshot.inputBufferSize
      result.push({
        id: "buffer-fallback",
        severity: "warning",
        title: t("warnings.audio.bufferFallback.title"),
        message: t("warnings.audio.bufferFallback.message", {
          requested:
            snapshot.requestedBufferSize?.toString() ??
            t("warnings.audio.bufferFallback.requestedUnknown"),
          actual:
            actual?.toString() ?? t("warnings.audio.bufferFallback.actualDeviceSelected")
        })
      })
    }

    if (
      snapshot.inputSampleRate !== null &&
      snapshot.outputSampleRate !== null &&
      snapshot.inputSampleRate !== snapshot.outputSampleRate
    ) {
      result.push({
        id: "device-sample-rate-mismatch",
        severity: "warning",
        title: t("warnings.audio.deviceSampleRateMismatch.title"),
        message: t("warnings.audio.deviceSampleRateMismatch.message", {
          inputRate: formatRate(snapshot.inputSampleRate),
          outputRate: formatRate(snapshot.outputSampleRate)
        })
      })
    } else if (snapshot.clockSync === "adaptive-resampled") {
      result.push({
        id: "independent-device-clocks",
        severity: "warning",
        title: t("warnings.audio.independentDeviceClocks.title"),
        message: t("warnings.audio.independentDeviceClocks.message")
      })
    }

    if (
      snapshot.sampleRate !== null &&
      snapshot.outputSampleRate !== null &&
      snapshot.sampleRate !== snapshot.outputSampleRate
    ) {
      result.push({
        id: "session-sample-rate-conversion",
        severity: "warning",
        title: t("warnings.audio.sessionSampleRateConversion.title"),
        message: t("warnings.audio.sessionSampleRateConversion.message", {
          sessionRate: formatRate(snapshot.sampleRate),
          outputRate: formatRate(snapshot.outputSampleRate)
        })
      })
    }

    if (
      snapshot.inputBufferSize !== null &&
      snapshot.outputBufferSize !== null &&
      snapshot.inputBufferSize !== snapshot.outputBufferSize
    ) {
      result.push({
        id: "asymmetric-buffers",
        severity: "warning",
        title: t("warnings.audio.asymmetricBuffers.title"),
        message: t("warnings.audio.asymmetricBuffers.message", {
          inputBuffer: snapshot.inputBufferSize,
          outputBuffer: snapshot.outputBufferSize
        })
      })
    }

    if (sessionXruns.value > 0) {
      const xrunKey =
        sessionXruns.value === 1 ? "warnings.audio.dropout" : "warnings.audio.dropouts"
      result.push({
        id: "xruns",
        severity: sessionXruns.value >= 5 ? "critical" : "warning",
        title: t(`${xrunKey}.title`, { count: sessionXruns.value }),
        message: t(`${xrunKey}.message`)
      })
    }

    if (
      snapshot.ringBufferFillFrames !== null &&
      snapshot.ringBufferCapacityFrames !== null &&
      snapshot.ringBufferCapacityFrames > 0 &&
      Date.now() - sessionStartedAt >= STARTUP_XRUN_GRACE_MS
    ) {
      const fillRatio = snapshot.ringBufferFillFrames / snapshot.ringBufferCapacityFrames
      if (fillRatio >= 0.95) {
        result.push({
          id: "ring-overrun-risk",
          severity: "warning",
          title: t("warnings.audio.ringOverrunRisk.title"),
          message: t("warnings.audio.ringOverrunRisk.message")
        })
      }
    }

    return result
  })

  return {
    runtime,
    lifecycle,
    latencyHistory,
    roundTripLatencyMeasurement,
    statistics,
    warnings,
    lastError,
    lastUpdatedAt,
    applyLifecycleState,
    refresh,
    startEngine,
    stopEngine,
    startRoundTripLatencyMeasurement,
    refreshRoundTripLatencyMeasurement,
    startPolling,
    stopPolling
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAudioRuntimeStore, import.meta.hot))
}

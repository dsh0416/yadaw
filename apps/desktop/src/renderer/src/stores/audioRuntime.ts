import { useIntervalFn } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type { AudioPreferences, AudioRuntimeSnapshot } from "@yadaw/contracts"

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
  const runtime = ref<AudioRuntimeSnapshot>({ ...INITIAL_AUDIO_RUNTIME_SNAPSHOT })
  const latencyHistory = shallowRef<AudioTelemetrySample[]>([])
  const lastError = ref("")
  const lastUpdatedAt = ref<number | null>(null)
  const xrunBaseline = ref(0)
  let sessionStartedAt = 0

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
    } else if (snapshot.state === "running" && capturedAt - sessionStartedAt < STARTUP_XRUN_GRACE_MS) {
      // A few callbacks can miss the pre-roll while the two CPAL streams settle.
      // Keep those startup artifacts out of the user-facing fault count.
      xrunBaseline.value = snapshot.xruns
    }

    runtime.value = snapshot
    lastUpdatedAt.value = capturedAt
    record(snapshot, capturedAt)
  }

  async function refresh(): Promise<void> {
    try {
      updateRuntime(await window.yadaw.audioEngineSnapshot())
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : "Unable to read audio engine state."
    }
  }

  async function startEngine(preferences: AudioPreferences): Promise<AudioRuntimeSnapshot> {
    try {
      const snapshot = await window.yadaw.startAudioEngine(preferences)
      lastError.value = ""
      updateRuntime(snapshot)
      return snapshot
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : "Unable to start the native audio engine."
      throw error
    }
  }

  async function stopEngine(): Promise<AudioRuntimeSnapshot> {
    try {
      const snapshot = await window.yadaw.stopAudioEngine()
      lastError.value = ""
      updateRuntime(snapshot)
      return snapshot
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : "Unable to stop the native audio engine."
      throw error
    }
  }

  const polling = useIntervalFn(
    () => void refresh(),
    POLLING_INTERVAL_MS,
    { immediate: false }
  )

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
        title: "Native audio error",
        message: lastError.value
      })
    } else if (snapshot.state === "error") {
      result.push({
        id: "engine-error",
        severity: "critical",
        title: "Audio engine stopped unexpectedly",
        message: "Open Preferences to select a working device configuration."
      })
    }

    if (snapshot.state !== "running") return result

    if (snapshot.bufferFallback) {
      const actual = snapshot.outputBufferSize ?? snapshot.inputBufferSize
      result.push({
        id: "buffer-fallback",
        severity: "warning",
        title: "I/O buffer fallback active",
        message: `The requested ${snapshot.requestedBufferSize ?? "unknown"}-frame buffer was unavailable; the engine is using ${actual ?? "a device-selected size"} frames.`
      })
    }

    if (
      snapshot.inputSampleRate !== null &&
      snapshot.sampleRate !== null &&
      snapshot.inputSampleRate !== snapshot.sampleRate
    ) {
      result.push({
        id: "sample-rate-mismatch",
        severity: "warning",
        title: "Sample-rate conversion active",
        message: `Input is ${formatRate(snapshot.inputSampleRate)} while the engine is ${formatRate(snapshot.sampleRate)}. Adaptive resampling is keeping the devices synchronized.`
      })
    } else if (snapshot.clockSync === "adaptive-resampled") {
      result.push({
        id: "independent-device-clocks",
        severity: "warning",
        title: "Independent device clocks",
        message: "Input and output use separate hardware clocks, so adaptive drift correction is active."
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
        title: "Asymmetric I/O buffers",
        message: `Input uses ${snapshot.inputBufferSize} frames and output uses ${snapshot.outputBufferSize} frames, so their hardware latency differs.`
      })
    }

    if (sessionXruns.value > 0) {
      result.push({
        id: "xruns",
        severity: sessionXruns.value >= 5 ? "critical" : "warning",
        title: `${sessionXruns.value} real-time ${sessionXruns.value === 1 ? "dropout" : "dropouts"}`,
        message: "The audio callback could not consume or produce data on time. Try a larger buffer or close CPU-heavy work."
      })
    }

    if (
      snapshot.ringBufferFillFrames !== null &&
      snapshot.ringBufferCapacityFrames !== null &&
      snapshot.ringBufferCapacityFrames > 0 &&
      Date.now() - sessionStartedAt >= STARTUP_XRUN_GRACE_MS
    ) {
      const fillRatio = snapshot.ringBufferFillFrames / snapshot.ringBufferCapacityFrames
      if (fillRatio <= 0.05) {
        result.push({
          id: "ring-underrun-risk",
          severity: "warning",
          title: "Ring buffer is nearly empty",
          message: "The output callback is close to starving. This may become an audible dropout under additional load."
        })
      } else if (fillRatio >= 0.95) {
        result.push({
          id: "ring-overrun-risk",
          severity: "warning",
          title: "Ring buffer is nearly full",
          message: "Input is outrunning output and may begin dropping captured samples."
        })
      }
    }

    return result
  })

  return {
    runtime,
    latencyHistory,
    statistics,
    warnings,
    lastError,
    lastUpdatedAt,
    refresh,
    startEngine,
    stopEngine,
    startPolling,
    stopPolling
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useAudioRuntimeStore, import.meta.hot))
}

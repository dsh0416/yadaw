import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import { useAudioRuntimeStore } from "./audioRuntime"
import { rpcSuccess, testBootstrap } from "../test/ipc"

describe("audio runtime sample-rate diagnostics", () => {
  beforeEach(() => setActivePinia(createPinia()))
  afterEach(() => vi.useRealTimers())

  it("reports native clock mismatch separately from session conversion", () => {
    const store = useAudioRuntimeStore()
    store.applyLifecycleState({
      status: "running",
      runtime: {
        ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
        state: "running",
        sampleRate: 44_100,
        inputSampleRate: 96_000,
        outputSampleRate: 48_000
      },
      error: null
    })

    expect(store.warnings.map((warning) => warning.id)).toEqual([
      "device-sample-rate-mismatch",
      "session-sample-rate-conversion"
    ])
  })

  it("does not label session conversion as a native device-clock mismatch", () => {
    const store = useAudioRuntimeStore()
    store.applyLifecycleState({
      status: "running",
      runtime: {
        ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
        state: "running",
        sampleRate: 44_100,
        inputSampleRate: 48_000,
        outputSampleRate: 48_000
      },
      error: null
    })

    expect(store.warnings.map((warning) => warning.id)).toEqual(["session-sample-rate-conversion"])
  })

  it("does not treat an empty monitoring ring as an audio warning", () => {
    vi.useFakeTimers()
    const store = useAudioRuntimeStore()
    store.applyLifecycleState({
      status: "running",
      runtime: {
        ...INITIAL_AUDIO_RUNTIME_SNAPSHOT,
        state: "running",
        ringBufferCapacityFrames: 1_024,
        ringBufferFillFrames: 0
      },
      error: null
    })
    vi.advanceTimersByTime(2_000)

    expect(store.warnings).toEqual([])
  })

  it("publishes physical loopback measurement state through the store", async () => {
    const store = useAudioRuntimeStore()
    const resources = testBootstrap().audioResources
    store.applyResources({
      ...resources,
      engine: {
        kind: "audio-engine",
        id: "audio-engine",
        epoch: resources.host.epoch,
        generation: 1
      },
      transport: null
    })
    window.yadaw.startRoundTripLatencyMeasurement = vi.fn().mockResolvedValue(
      rpcSuccess({
        status: "preparing",
        inputChannel: 1,
        outputChannel: 2,
        measuredRoundTripLatencyMs: null,
        failure: null
      })
    )
    window.yadaw.roundTripLatencyMeasurementSnapshot = vi.fn().mockResolvedValue(
      rpcSuccess({
        status: "complete",
        inputChannel: 1,
        outputChannel: 2,
        measuredRoundTripLatencyMs: 9.5,
        failure: null
      })
    )

    await store.startRoundTripLatencyMeasurement({ inputChannel: 1, outputChannel: 2 })
    expect(store.roundTripLatencyMeasurement.status).toBe("preparing")
    await store.refreshRoundTripLatencyMeasurement()
    expect(store.roundTripLatencyMeasurement.measuredRoundTripLatencyMs).toBe(9.5)
  })
})

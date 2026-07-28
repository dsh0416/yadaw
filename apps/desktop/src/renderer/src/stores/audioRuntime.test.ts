import { beforeEach, describe, expect, it } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import { useAudioRuntimeStore } from "./audioRuntime"

describe("audio runtime sample-rate diagnostics", () => {
  beforeEach(() => setActivePinia(createPinia()))

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
})

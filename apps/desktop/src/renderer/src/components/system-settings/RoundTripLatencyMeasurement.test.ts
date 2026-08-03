import { mount, flushPromises } from "@vue/test-utils"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import RoundTripLatencyMeasurement from "./RoundTripLatencyMeasurement.vue"
import { rpcSuccess, testBootstrap } from "../../test/ipc"
import { useAudioRuntimeStore } from "../../stores/audioRuntime"

describe("RoundTripLatencyMeasurement", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts with the selected channels and reports a completed physical result", async () => {
    const resources = testBootstrap().audioResources
    useAudioRuntimeStore().applyResources({
      ...resources,
      engine: {
        kind: "audio-engine",
        id: "audio-engine",
        epoch: resources.host.epoch,
        generation: 1
      },
      transport: null
    })
    window.heron.startRoundTripLatencyMeasurement = vi.fn().mockResolvedValue(
      rpcSuccess({
        status: "preparing",
        inputChannel: 2,
        outputChannel: 2,
        measuredRoundTripLatencyMs: null,
        failure: null
      })
    )
    window.heron.roundTripLatencyMeasurementSnapshot = vi.fn().mockResolvedValue(
      rpcSuccess({
        status: "complete",
        inputChannel: 2,
        outputChannel: 2,
        measuredRoundTripLatencyMs: 12.34,
        failure: null
      })
    )
    const wrapper = mount(RoundTripLatencyMeasurement, {
      props: {
        runtimeState: "running",
        inputChannelCount: 2,
        outputChannelCount: 2,
        estimatedLatencyMs: 11.5
      }
    })

    await wrapper.get('select[aria-label="Loopback output channel"]').setValue("2")
    await wrapper.get('select[aria-label="Loopback input channel"]').setValue("2")
    await wrapper.get("button").trigger("click")
    await flushPromises()

    expect(window.heron.startRoundTripLatencyMeasurement).toHaveBeenCalledWith(expect.any(Object), {
      inputChannel: 2,
      outputChannel: 2
    })
    await vi.advanceTimersByTimeAsync(100)
    await flushPromises()
    expect(wrapper.text()).toContain("Measured 12.34 ms")
    expect(wrapper.text()).toContain("callback estimate is 11.50 ms")
  })

  it("disables measurement while the audio engine is stopped", () => {
    const wrapper = mount(RoundTripLatencyMeasurement, {
      props: {
        runtimeState: "stopped",
        inputChannelCount: 2,
        outputChannelCount: 2,
        estimatedLatencyMs: null
      }
    })

    expect(wrapper.get("button").attributes("disabled")).toBeDefined()
    expect(wrapper.text()).toContain("Start the audio engine")
  })
})

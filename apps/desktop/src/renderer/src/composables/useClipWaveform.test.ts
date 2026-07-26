import { createPinia, setActivePinia } from "pinia"
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, h, nextTick, ref } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WaveformPeakWindow } from "@yadaw/contracts"
import { useClipWaveform } from "./useClipWaveform"

function response(id: string, frameCount: number): WaveformPeakWindow {
  return {
    id,
    sampleRate: 48_000,
    channels: 2,
    frameCount,
    startFrame: 0,
    endFrame: frameCount,
    framesPerBucket: 64,
    bucketCount: 0,
    peaks: new Uint8Array()
  }
}

describe("useClipWaveform", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("polls staging every 50 ms and stops after unmount", async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(response("recording", 2_400))
      .mockResolvedValue(response("recording", 4_800))
    window.yadaw.recordingWaveformSnapshot = read
    const component = defineComponent({
      setup() {
        const waveform = useClipWaveform({
          id: "recording",
          recording: true,
          startFrame: 0,
          endFrame: Number.MAX_SAFE_INTEGER,
          pixelWidth: 100
        })
        return () => h("span", String(waveform.data.value?.frameCount ?? 0))
      }
    })
    const wrapper = mount(component)

    await vi.advanceTimersByTimeAsync(40)
    expect(read).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toBe("2400")
    await vi.advanceTimersByTimeAsync(10)
    expect(read).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toBe("4800")

    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(200)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it("debounces viewport changes and discards stale responses", async () => {
    const startFrame = ref(0)
    let resolveFirst!: (value: WaveformPeakWindow) => void
    let resolveSecond!: (value: WaveformPeakWindow) => void
    window.yadaw.readAssetWaveform = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve
          })
      )
    const component = defineComponent({
      setup() {
        const waveform = useClipWaveform({
          id: "asset",
          recording: false,
          startFrame,
          endFrame: 9_600,
          pixelWidth: 200
        })
        return () => h("span", String(waveform.data.value?.frameCount ?? 0))
      }
    })
    const wrapper = mount(component)
    await vi.advanceTimersByTimeAsync(40)

    startFrame.value = 64
    await nextTick()
    await vi.advanceTimersByTimeAsync(39)
    expect(window.yadaw.readAssetWaveform).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(window.yadaw.readAssetWaveform).toHaveBeenCalledTimes(2)

    resolveSecond(response("asset", 9_600))
    await flushPromises()
    expect(wrapper.text()).toBe("9600")
    resolveFirst(response("asset", 1))
    await flushPromises()
    expect(wrapper.text()).toBe("9600")
    wrapper.unmount()
  })

  it("keeps the last live frame until the finalized asset response takes over", async () => {
    const recording = ref(true)
    let resolveAsset!: (value: WaveformPeakWindow) => void
    window.yadaw.recordingWaveformSnapshot = vi.fn().mockResolvedValue(response("take", 4_800))
    window.yadaw.readAssetWaveform = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAsset = resolve
        })
    )
    const component = defineComponent({
      setup() {
        const waveform = useClipWaveform({
          id: "take",
          recording,
          startFrame: 0,
          endFrame: 48_000,
          pixelWidth: 100
        })
        return () => h("span", String(waveform.data.value?.frameCount ?? 0))
      }
    })
    const wrapper = mount(component)
    await vi.advanceTimersByTimeAsync(40)
    expect(wrapper.text()).toBe("4800")

    recording.value = false
    await nextTick()
    await vi.advanceTimersByTimeAsync(40)
    expect(wrapper.text()).toBe("4800")
    resolveAsset(response("take", 48_000))
    await flushPromises()
    expect(wrapper.text()).toBe("48000")
    wrapper.unmount()
  })
})

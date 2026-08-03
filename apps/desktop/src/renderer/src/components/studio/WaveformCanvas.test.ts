import { mount } from "@vue/test-utils"
import { nextTick } from "vue"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { WaveformPeakWindow } from "@yadaw/contracts"
import WaveformCanvas from "./WaveformCanvas.vue"

function encode(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer)
}

const peaks: WaveformPeakWindow = {
  id: "asset",
  sampleRate: 48_000,
  channels: 2,
  frameCount: 128,
  startFrame: 0,
  endFrame: 128,
  framesPerBucket: 64,
  bucketCount: 2,
  peaks: encode([-1, 0.5, -0.25, 0.25, -0.5, 0.75, -0.75, 1])
}

describe("WaveformCanvas", () => {
  const context = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeStyle: "",
    globalAlpha: 1,
    lineWidth: 1
  }

  beforeEach(() => {
    Object.values(context).forEach((value) => {
      if (typeof value === "function" && "mockClear" in value) value.mockClear()
    })
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      context as unknown as CanvasRenderingContext2D
    )
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 2 })
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.callback(
          [
            {
              target,
              contentRect: { width: 120, height: 60 }
            } as ResizeObserverEntry
          ],
          this
        )
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it("uses DPR-aware backing pixels and redraws for resize, mode, and amplitude", async () => {
    const wrapper = mount(WaveformCanvas, {
      props: {
        window: peaks,
        displayMode: "separate",
        amplitudeScale: 1,
        loading: false
      }
    })
    await nextTick()
    const canvas = wrapper.get("canvas").element as HTMLCanvasElement
    expect(canvas.width).toBe(240)
    expect(canvas.height).toBe(120)
    expect(context.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
    expect(wrapper.get("canvas").attributes("aria-label")).toContain("2 channels, 128 frames")

    const strokes = context.stroke.mock.calls.length
    await wrapper.setProps({ displayMode: "aggregate", amplitudeScale: 2 })
    await nextTick()
    expect(context.stroke.mock.calls.length).toBeGreaterThan(strokes)
  })

  it("resolves a visible recording color before drawing into the canvas", async () => {
    const wrapper = mount(WaveformCanvas, {
      props: {
        window: peaks,
        displayMode: "separate",
        amplitudeScale: 1,
        loading: false,
        recording: true
      }
    })
    await nextTick()

    expect(context.strokeStyle).toBe("#ffd2d8")
    wrapper.unmount()
  })

  it("announces loading and unavailable empty states without fake peaks", async () => {
    const wrapper = mount(WaveformCanvas, {
      props: {
        window: null,
        displayMode: "separate",
        amplitudeScale: 1,
        loading: true
      }
    })
    expect(wrapper.get("canvas").attributes("aria-label")).toBe("Waveform loading")
    expect(context.lineTo).not.toHaveBeenCalled()
    await wrapper.setProps({ loading: false })
    expect(wrapper.get("canvas").attributes("aria-label")).toBe("Waveform unavailable")
  })
})

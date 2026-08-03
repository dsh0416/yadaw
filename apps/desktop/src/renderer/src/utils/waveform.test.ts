import { describe, expect, it } from "vitest"
import type { WaveformPeakWindow } from "@heron/contracts"
import {
  aggregateWaveformPeaks,
  buildWaveformGeometry,
  buildWarpedWaveformGeometry,
  decodeWaveformPeaks,
  mergeWaveformChannels
} from "./waveform"

function encode(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}

function peakWindow(values: number[], bucketCount: number, channels: number): WaveformPeakWindow {
  return {
    id: "asset",
    sampleRate: 48_000,
    channels,
    frameCount: bucketCount * 64,
    startFrame: 0,
    endFrame: bucketCount * 64,
    framesPerBucket: 64,
    bucketCount,
    peaks: encode(values)
  }
}

describe("waveform utilities", () => {
  it("decodes the fixed little-endian Float32 representation", () => {
    expect([...decodeWaveformPeaks(encode([-1, 0.25, 1]))]).toEqual([-1, 0.25, 1])
    expect(() => decodeWaveformPeaks(new Uint8Array(3))).toThrow("Float32-aligned")
  })

  it("re-aggregates with min-of-min and max-of-max for every channel", () => {
    const source = new Float32Array([
      -0.125, 0.25, -0.5, 0.5, -0.75, 0.125, -0.25, 0.75, -0.5, 0.625, -0.625, 0.25, -1, 0.5,
      -0.125, 1
    ])
    expect([...aggregateWaveformPeaks(source, 4, 2, 2)]).toEqual([
      -0.75, 0.25, -0.5, 0.75, -1, 0.625, -0.625, 1
    ])
  })

  it("merges any number of channels conservatively", () => {
    const source = new Float32Array([
      -0.25, 0.5, -0.75, 0.125, -0.125, 0.875, -1, 0.25, -0.5, 1, -0.625, 0.5
    ])
    expect([...mergeWaveformChannels(source, 2, 3)]).toEqual([-0.75, 0.875, -1, 1])
  })

  it("produces exact separate and aggregate canvas coordinates", () => {
    const window = peakWindow([-1, 0.5, -0.25, 0.25, -0.5, 0.75, -0.75, 1], 2, 2)
    expect(buildWaveformGeometry(window, "separate", 1, 100, 1)).toEqual({
      lanes: 2,
      lines: [
        { x: 0.5, minimumY: 50, maximumY: 6.25, lane: 0 },
        { x: 0.5, minimumY: 93.75, maximumY: 50, lane: 1 }
      ]
    })
    expect(buildWaveformGeometry(window, "aggregate", 1, 100, 1)).toEqual({
      lanes: 1,
      lines: [{ x: 0.5, minimumY: 100, maximumY: 0, lane: 0 }]
    })
  })

  it("clips amplitude without inventing data and handles empty or incomplete windows", () => {
    const window = peakWindow([-0.75, 0.75], 1, 1)
    expect(buildWaveformGeometry(window, "separate", 10, 20, 2).lines[0]).toEqual({
      x: 5,
      minimumY: 20,
      maximumY: 0,
      lane: 0
    })
    expect(
      buildWaveformGeometry(
        { ...window, bucketCount: 0, peaks: new Uint8Array() },
        "separate",
        10,
        20,
        1
      )
    ).toEqual({ lanes: 1, lines: [] })
    expect(() =>
      buildWaveformGeometry({ ...window, peaks: new Uint8Array() }, "separate", 10, 20, 1)
    ).toThrow("incomplete")
  })

  it("stretches and compresses source buckets across piecewise timeline segments", () => {
    const window = peakWindow([-1, 1, -0.75, 0.75, -0.5, 0.5, -0.25, 0.25], 4, 1)
    const geometry = buildWarpedWaveformGeometry(window, "separate", 4, 20, 1, (x) =>
      x <= 2 ? (x / 2) * 64 : 64 + ((x - 2) / 2) * 192
    )

    expect(geometry.lines).toEqual([
      { x: 0.5, minimumY: 20, maximumY: 0, lane: 0 },
      { x: 1.5, minimumY: 20, maximumY: 0, lane: 0 },
      { x: 2.5, minimumY: 17.5, maximumY: 2.5, lane: 0 },
      { x: 3.5, minimumY: 15, maximumY: 5, lane: 0 }
    ])
  })
})

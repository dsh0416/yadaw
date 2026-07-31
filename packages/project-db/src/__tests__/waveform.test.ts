import { describe, expect, it, vi } from "vitest"
import { readWaveformWindow, type WaveformExecutor } from "../waveform"

function executorWithRows(rows: unknown[]): WaveformExecutor {
  return {
    execute: vi.fn(async () => ({ rows })) as unknown as WaveformExecutor["execute"]
  }
}

describe("readWaveformWindow", () => {
  it("rejects non-integer window arguments", async () => {
    const executor = executorWithRows([])
    await expect(readWaveformWindow(executor, "a", 1, 0.5, 10, 16)).rejects.toThrow(/safe integers/)
    await expect(readWaveformWindow(executor, "a", 1, 0, 10, 1.5)).rejects.toThrow(/maxBuckets/)
  })

  it("returns null when no waveform level exists", async () => {
    const executor = executorWithRows([])
    await expect(readWaveformWindow(executor, "asset-1", 1, 0, 100, 16)).resolves.toBeNull()
  })

  it("maps a stored window row into a waveform snapshot", async () => {
    const peaks = new Uint8Array([1, 2, 3, 4])
    const executor = executorWithRows([
      {
        sample_rate: 48_000,
        channels: 1,
        frame_count: 100,
        start_frame: 0,
        end_frame: 64,
        frames_per_bucket: 4,
        window_bucket_count: 16,
        window_peaks: peaks
      }
    ])

    await expect(readWaveformWindow(executor, "asset-1", 2, 0, 100, 16)).resolves.toEqual({
      sampleRate: 48_000,
      channels: 1,
      frameCount: 100,
      startFrame: 0,
      endFrame: 64,
      framesPerBucket: 4,
      bucketCount: 16,
      peaks
    })
  })

  it("rejects invalid numeric fields from storage", async () => {
    const executor = executorWithRows([
      {
        sample_rate: -1,
        channels: 1,
        frame_count: 10,
        start_frame: 0,
        end_frame: 10,
        frames_per_bucket: 1,
        window_bucket_count: 1,
        window_peaks: new Uint8Array([0])
      }
    ])

    await expect(readWaveformWindow(executor, "asset-1", 1, 0, 10, 8)).rejects.toThrow(
      /invalid sample_rate/
    )
  })

  it("rejects invalid peak payloads", async () => {
    const executor = executorWithRows([
      {
        sample_rate: 48_000,
        channels: 1,
        frame_count: 10,
        start_frame: 0,
        end_frame: 10,
        frames_per_bucket: 1,
        window_bucket_count: 1,
        window_peaks: "not-bytes"
      }
    ])

    await expect(readWaveformWindow(executor, "asset-1", 1, 0, 10, 8)).rejects.toThrow(
      /invalid peak data/
    )
  })
})

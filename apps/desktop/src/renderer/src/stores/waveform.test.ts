import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { WaveformWindowRequest } from "@yadaw/contracts"
import { useWaveformStore } from "./waveform"

function response(request: WaveformWindowRequest) {
  return {
    ...request,
    sampleRate: 48_000,
    channels: 2,
    frameCount: request.endFrame,
    framesPerBucket: 64,
    bucketCount: 0,
    peaks: new Uint8Array()
  }
}

describe("waveform store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.yadaw.readAssetWaveform = vi.fn(async (request) => response(request))
  })

  it("reuses asset windows and evicts the least-recently-used entry at its bound", async () => {
    const store = useWaveformStore()
    const first = { id: "asset-0", startFrame: 0, endFrame: 64, maxBuckets: 10 }
    await store.loadAsset(first)
    await store.loadAsset(first)
    expect(window.yadaw.readAssetWaveform).toHaveBeenCalledTimes(1)

    for (let index = 1; index <= 96; index += 1) {
      await store.loadAsset({
        id: `asset-${index}`,
        startFrame: 0,
        endFrame: 64,
        maxBuckets: 10
      })
    }
    await store.loadAsset(first)
    expect(window.yadaw.readAssetWaveform).toHaveBeenCalledTimes(98)
  })
})

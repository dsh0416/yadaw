import { describe, expect, it, vi } from "vitest"
import { MixerRuntimeService } from "./mixer-runtime-service"

describe("MixerRuntimeService", () => {
  it.each([
    [{ target: "plugin", parameter: "gain", value: 0.5 }, true],
    [{ target: "channel", parameter: "pan", value: -1 }, true],
    [{ target: "channel", parameter: "volume", value: -90 }, true],
    [{ target: "plugin", parameter: "gain", value: 2 }, false],
    [{ target: "channel", parameter: "pan", value: -2 }, false],
    [{ target: "channel", parameter: "volume", value: 13 }, false]
  ] as const)("validates preview range for %j", async (preview, valid) => {
    const previewMixerParameter = vi.fn().mockResolvedValue(undefined)
    const service = new MixerRuntimeService({ previewMixerParameter } as never)

    if (valid) {
      await expect(service.preview(preview as never)).resolves.toBeUndefined()
      expect(previewMixerParameter).toHaveBeenCalledWith(preview)
    } else {
      await expect(service.preview(preview as never)).rejects.toThrow("Mixer preview")
      expect(previewMixerParameter).not.toHaveBeenCalled()
    }
  })

  it("delegates meter snapshots and clip clearing to the audio host", async () => {
    const snapshot = { meters: [], capturedAt: 123 }
    const mixerSnapshot = vi.fn().mockResolvedValue(snapshot)
    const clearMeterClips = vi.fn().mockResolvedValue(snapshot)
    const service = new MixerRuntimeService({ mixerSnapshot, clearMeterClips } as never)

    await expect(service.runtimeSnapshot()).resolves.toBe(snapshot)
    await expect(service.clearMeterClips()).resolves.toBe(snapshot)
  })

  it("provides an empty snapshot when audio is unavailable", async () => {
    vi.spyOn(Date, "now").mockReturnValue(456)
    const service = new MixerRuntimeService(null)

    await expect(
      service.preview({ target: "channel", parameter: "pan", value: 0 } as never)
    ).resolves.toBeUndefined()
    await expect(service.runtimeSnapshot()).resolves.toEqual({ meters: [], capturedAt: 456 })
    await expect(service.clearMeterClips()).resolves.toEqual({ meters: [], capturedAt: 456 })
  })
})

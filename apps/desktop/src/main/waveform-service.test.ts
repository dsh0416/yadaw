import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest"
import type { ApplicationSettingsStore } from "./application-settings"
import type { ProjectService } from "./project-service"
import { WaveformService } from "./waveform-service"

const analyzeWaveform = vi.hoisted(() => vi.fn())

vi.mock("@yadaw/dsp-node", () => ({ analyzeWaveform }))

let swapDirectory: string

function window(overrides: Record<string, unknown> = {}) {
  return {
    sampleRate: 48_000,
    channels: 2,
    frameCount: 4_800,
    startFrame: 0,
    endFrame: 4_800,
    framesPerBucket: 64,
    bucketCount: 2,
    peaks: new Uint8Array(2 * 2 * 8),
    ...overrides
  }
}

const request = { id: "asset-1", startFrame: 0, endFrame: 4_800, maxBuckets: 512 }

type Window = ReturnType<typeof window>

interface Stubs {
  service: WaveformService
  projects: {
    current: { id: string } | null
    readAssetWaveform: Mock<() => Promise<Window | null>>
    readAssetAudio: Mock<() => Promise<Uint8Array>>
    storeAssetWaveform: Mock<() => Promise<void>>
    assetsMissingWaveform: Mock<() => Promise<string[]>>
  }
}

function createService(): Stubs {
  const projects: Stubs["projects"] = {
    current: { id: "project-1" },
    readAssetWaveform: vi.fn(async () => window()),
    readAssetAudio: vi.fn(async () => new Uint8Array([1, 2, 3])),
    storeAssetWaveform: vi.fn(async () => undefined),
    assetsMissingWaveform: vi.fn(async () => [])
  }
  const settings = {
    get: async () => ({ swapDirectory })
  } as unknown as ApplicationSettingsStore

  return {
    projects,
    service: new WaveformService(settings, projects as unknown as ProjectService)
  }
}

beforeEach(async () => {
  swapDirectory = join(await mkdtemp(join(tmpdir(), "yadaw-waveform-")), "swap")
  analyzeWaveform.mockReset()
  analyzeWaveform.mockResolvedValue({
    sampleRate: 48_000,
    channels: 2,
    frameCount: 4_800,
    waveformLevels: [{ framesPerBucket: 64, bucketCount: 2, peaks: new Uint8Array(32) }]
  })
})

afterEach(async () => {
  await rm(swapDirectory, { recursive: true, force: true })
})

describe("readAsset validation", () => {
  it("rejects an empty or oversized source id", async () => {
    const { service } = createService()

    await expect(service.readAsset({ ...request, id: "" })).rejects.toThrow(
      "Invalid waveform source id"
    )
    await expect(service.readAsset({ ...request, id: "a".repeat(257) })).rejects.toThrow(
      "Invalid waveform source id"
    )
  })

  it("rejects a negative or non-integer start frame", async () => {
    const { service } = createService()

    await expect(service.readAsset({ ...request, startFrame: -1 })).rejects.toThrow(
      "Waveform start frame must be a non-negative integer"
    )
    await expect(service.readAsset({ ...request, startFrame: 1.5 })).rejects.toThrow(
      "Waveform start frame must be a non-negative integer"
    )
  })

  it("rejects an end frame before the start", async () => {
    const { service } = createService()

    await expect(service.readAsset({ ...request, startFrame: 100, endFrame: 50 })).rejects.toThrow(
      "Waveform end frame must not precede its start"
    )
  })

  it("bounds the bucket count", async () => {
    const { service } = createService()

    await expect(service.readAsset({ ...request, maxBuckets: 0 })).rejects.toThrow(
      "Waveform bucket count must be between 1 and 4096"
    )
    await expect(service.readAsset({ ...request, maxBuckets: 4_097 })).rejects.toThrow(
      "Waveform bucket count must be between 1 and 4096"
    )
  })
})

describe("readAsset", () => {
  it("returns a cached window without touching the analyzer", async () => {
    const { service, projects } = createService()

    const result = await service.readAsset(request)

    expect(result.id).toBe("asset-1")
    expect(result.bucketCount).toBe(2)
    expect(projects.readAssetWaveform).toHaveBeenCalledTimes(1)
    expect(analyzeWaveform).not.toHaveBeenCalled()
  })

  it("rebuilds the cache when it is missing and returns the fresh window", async () => {
    const { service, projects } = createService()
    projects.readAssetWaveform.mockResolvedValueOnce(null).mockResolvedValueOnce(window())

    const result = await service.readAsset(request)

    expect(analyzeWaveform).toHaveBeenCalledTimes(1)
    expect(projects.storeAssetWaveform).toHaveBeenCalledTimes(1)
    expect(result.bucketCount).toBe(2)
  })

  it("rebuilds when the cached peak buffer does not match its bucket count", async () => {
    const { service, projects } = createService()
    projects.readAssetWaveform
      .mockResolvedValueOnce(window({ peaks: new Uint8Array(4) }))
      .mockResolvedValueOnce(window())

    await service.readAsset(request)

    expect(analyzeWaveform).toHaveBeenCalledTimes(1)
  })

  it("rebuilds when the cached window reports an impossible rate or channel count", async () => {
    for (const invalid of [
      { sampleRate: 0 },
      { channels: 0 },
      { framesPerBucket: 0 },
      { bucketCount: -1 }
    ]) {
      const { service, projects } = createService()
      projects.readAssetWaveform
        .mockResolvedValueOnce(window(invalid))
        .mockResolvedValueOnce(window())

      await service.readAsset(request)

      expect(projects.storeAssetWaveform, JSON.stringify(invalid)).toHaveBeenCalledTimes(1)
    }
  })

  it("fails when even a rebuilt cache is unusable", async () => {
    const { service, projects } = createService()
    projects.readAssetWaveform.mockResolvedValue(null)

    await expect(service.readAsset(request)).rejects.toThrow(
      "Waveform cache could not be generated"
    )
  })

  it("refuses to rebuild without an open project", async () => {
    const { service, projects } = createService()
    projects.readAssetWaveform.mockResolvedValue(null)
    projects.current = null

    await expect(service.readAsset(request)).rejects.toThrow("No project is open")
  })

  it("removes the temporary analysis file even when analysis fails", async () => {
    const { service, projects } = createService()
    projects.readAssetWaveform.mockResolvedValue(null)
    analyzeWaveform.mockRejectedValue(new Error("not a wave file"))

    await expect(service.readAsset(request)).rejects.toThrow("not a wave file")

    expect(analyzeWaveform).toHaveBeenCalledWith(
      expect.stringContaining(join(swapDirectory, ".waveform-"))
    )
    await expect(readdir(swapDirectory)).resolves.toEqual([])
  })

  it("discards the analysis when the project changed while it ran", async () => {
    const { service, projects } = createService()
    projects.readAssetWaveform.mockResolvedValue(null)
    analyzeWaveform.mockImplementation(async () => {
      projects.current = { id: "project-2" }
      return {
        sampleRate: 48_000,
        channels: 2,
        frameCount: 4_800,
        waveformLevels: []
      }
    })

    await expect(service.readAsset(request)).rejects.toThrow(
      "Waveform cache could not be generated"
    )

    expect(projects.storeAssetWaveform).not.toHaveBeenCalled()
  })

  it("shares one rebuild between concurrent readers of the same asset", async () => {
    const { service, projects } = createService()
    projects.readAssetWaveform.mockImplementation(async () =>
      projects.storeAssetWaveform.mock.calls.length > 0 ? window() : null
    )
    let release: (() => void) | undefined
    analyzeWaveform.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return {
        sampleRate: 48_000,
        channels: 2,
        frameCount: 4_800,
        waveformLevels: [{ framesPerBucket: 64, bucketCount: 2, peaks: new Uint8Array(32) }]
      }
    })

    const reads = Promise.all([service.readAsset(request), service.readAsset(request)])
    await vi.waitFor(() => expect(release).toBeDefined())
    release?.()
    await reads

    expect(analyzeWaveform).toHaveBeenCalledTimes(1)
  })
})

describe("prepareMissing", () => {
  it("rebuilds every asset the project reports as missing a cache", async () => {
    const { service, projects } = createService()
    projects.assetsMissingWaveform.mockResolvedValue(["asset-1", "asset-2"])

    await service.prepareMissing()

    expect(analyzeWaveform).toHaveBeenCalledTimes(2)
    expect(projects.storeAssetWaveform).toHaveBeenCalledTimes(2)
  })

  it("does nothing without an open project", async () => {
    const { service, projects } = createService()
    projects.current = null

    await service.prepareMissing()

    expect(projects.assetsMissingWaveform).not.toHaveBeenCalled()
  })

  it("keeps going when one asset cannot be analyzed", async () => {
    const { service, projects } = createService()
    projects.assetsMissingWaveform.mockResolvedValue(["asset-1", "asset-2"])
    analyzeWaveform.mockRejectedValueOnce(new Error("not a wave file"))

    await expect(service.prepareMissing()).resolves.toBeUndefined()

    expect(projects.storeAssetWaveform).toHaveBeenCalledTimes(1)
  })

  it("swallows a damaged cache index rather than failing the project open", async () => {
    const { service, projects } = createService()
    projects.assetsMissingWaveform.mockRejectedValue(new Error("cache index is corrupt"))

    await expect(service.prepareMissing()).resolves.toBeUndefined()
  })

  it("stops as soon as a different project is opened", async () => {
    const { service, projects } = createService()
    projects.assetsMissingWaveform.mockResolvedValue(["asset-1", "asset-2"])
    projects.storeAssetWaveform.mockImplementation(async () => {
      projects.current = { id: "project-2" }
    })

    await service.prepareMissing()

    expect(projects.storeAssetWaveform).toHaveBeenCalledTimes(1)
  })
})

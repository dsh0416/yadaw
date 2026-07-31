import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProjectGraphSnapshot } from "@yadaw/contracts"
import { AssetMaterializer } from "./asset-materializer"

const graph: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [],
  channels: [],
  audioClips: [
    {
      id: "clip-1",
      assetId: "asset/one",
      trackId: "track-1",
      name: "Take",
      startFrame: 0,
      sourceOffsetFrames: 0,
      lengthFrames: 10,
      assetSampleRate: 48_000,
      assetChannels: 1
    },
    {
      id: "clip-2",
      assetId: "asset/one",
      trackId: "track-1",
      name: "Take 2",
      startFrame: 10,
      sourceOffsetFrames: 0,
      lengthFrames: 10,
      assetSampleRate: 48_000,
      assetChannels: 1
    }
  ],
  sends: [],
  plugins: [],
  midiClips: [],
  tempoMap: {
    ticksPerQuarter: 960,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: []
}

describe("AssetMaterializer", () => {
  let userData: string

  afterEach(async () => {
    if (userData) await rm(userData, { recursive: true, force: true })
  })

  it("materializes unique assets into the mixer cache", async () => {
    userData = await mkdtemp(join(tmpdir(), "asset-materializer-"))
    const source = {
      assetContentHashes: vi.fn(async () => [{ id: "asset/one", contentHash: "hash1" }]),
      readAssetAudio: vi.fn(async () => new Uint8Array([1, 2, 3, 4]))
    }
    const materializer = new AssetMaterializer(userData, source as never)

    const paths = await materializer.materialize(graph, source)

    expect(source.assetContentHashes).toHaveBeenCalledWith(["asset/one"])
    expect(source.readAssetAudio).toHaveBeenCalledOnce()
    const path = paths.get("asset/one")
    expect(path).toMatch(/asset_one-hash1\.bwf$/)
    await expect(readFile(path!)).resolves.toEqual(Buffer.from([1, 2, 3, 4]))
  })

  it("reuses an already materialized cache file", async () => {
    userData = await mkdtemp(join(tmpdir(), "asset-materializer-"))
    const source = {
      assetContentHashes: vi.fn(async () => [{ id: "asset/one", contentHash: "hash1" }]),
      readAssetAudio: vi.fn(async () => new Uint8Array([9]))
    }
    const materializer = new AssetMaterializer(userData, source as never)

    const first = await materializer.materialize(graph, source)
    const second = await materializer.materialize(graph, source)

    expect(first.get("asset/one")).toBe(second.get("asset/one"))
    expect(source.readAssetAudio).toHaveBeenCalledOnce()
    await expect(access(first.get("asset/one")!)).resolves.toBeUndefined()
  })

  it("falls back to an unknown hash when the content hash is missing", async () => {
    userData = await mkdtemp(join(tmpdir(), "asset-materializer-"))
    const source = {
      assetContentHashes: vi.fn(async () => []),
      readAssetAudio: vi.fn(async () => new Uint8Array([7]))
    }
    const materializer = new AssetMaterializer(userData, source as never)

    const paths = await materializer.materialize(graph, source)

    expect(paths.get("asset/one")).toMatch(/asset_one-unknown\.bwf$/)
  })
})

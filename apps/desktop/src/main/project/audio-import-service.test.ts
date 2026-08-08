import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectAudioAssetSummary } from "@heron/contracts"
import type { ProjectService } from "./project-service"
import { AudioImportBatchError, AudioImportService } from "./audio-import-service"

const importAudioFile = vi.hoisted(() => vi.fn())

vi.mock("@heron/dsp-node", () => ({ importAudioFile }))

let directory: string

function converted(contentHash = "audio-hash") {
  return {
    contentHash,
    sampleRate: 48_000,
    channels: 2,
    frameCount: 96_000,
    waveformLevels: [{ framesPerBucket: 256, bucketCount: 1, peaks: Buffer.from([1, 2, 3, 4]) }]
  }
}

function audioAsset(overrides: Partial<ProjectAudioAssetSummary> = {}): ProjectAudioAssetSummary {
  return {
    id: "existing-audio",
    kind: "audio",
    name: "First name.wav",
    contentHash: "audio-hash",
    sampleRate: 48_000,
    channels: 2,
    bitDepth: "float32",
    frameCount: 96_000n,
    ...overrides
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "heron-audio-import-"))
  importAudioFile.mockReset()
  importAudioFile.mockResolvedValue(converted())
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe("AudioImportService", () => {
  it("transcodes supported input into a canonical project audio asset", async () => {
    const projects = {
      listAssets: vi.fn(async () => []),
      importLargeObject: vi.fn(async () => undefined)
    }
    const service = new AudioImportService(directory, projects as unknown as ProjectService)

    const result = await service.import(["/samples/Kick.mp3"], "operation-1")

    expect(result.importedAssetIds).toHaveLength(1)
    expect(result.selectedAssetIds).toEqual(result.importedAssetIds)
    expect(importAudioFile).toHaveBeenCalledWith(
      expect.objectContaining({ inputPath: "/samples/Kick.mp3", originator: "Heron" })
    )
    expect(projects.importLargeObject).toHaveBeenCalledWith(
      expect.stringMatching(/\.bwf$/),
      "operation-1",
      expect.objectContaining({
        id: result.importedAssetIds[0],
        name: "Kick.mp3",
        mimeType: "audio/x-bwf",
        contentHash: "audio-hash",
        sampleRate: 48_000,
        channels: 2,
        bitDepth: "float32",
        frameCount: 96_000n
      }),
      expect.any(Function)
    )
  })

  it("deduplicates by content hash and retains the first imported name", async () => {
    const existing = audioAsset()
    const projects = {
      listAssets: vi.fn(async () => [existing]),
      importLargeObject: vi.fn(async () => undefined)
    }
    const service = new AudioImportService(directory, projects as unknown as ProjectService)

    const result = await service.import(["/renamed/Same Content.flac"], "operation-2")

    expect(result).toEqual({ selectedAssetIds: [existing.id], importedAssetIds: [] })
    expect(projects.importLargeObject).not.toHaveBeenCalled()
  })

  it("reports whether a failed batch may already have changed the project", async () => {
    const projects = {
      listAssets: vi.fn(async () => []),
      importLargeObject: vi.fn(async () => {
        throw new Error("worker result lost")
      })
    }
    const service = new AudioImportService(directory, projects as unknown as ProjectService)

    const failure = await service
      .import(["/samples/Kick.wav"], "operation-3")
      .catch((error) => error)

    expect(failure).toBeInstanceOf(AudioImportBatchError)
    expect(failure).toMatchObject({ databaseWriteDispatched: true, importedAssetIds: [] })
  })
})

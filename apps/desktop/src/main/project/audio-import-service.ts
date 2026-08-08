import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { basename, join } from "node:path"
import { importAudioFile } from "@heron/dsp-node"
import type { ProjectAudioAssetSummary } from "@heron/contracts"
import type { ProjectService } from "./project-service"

export interface AudioImportBatchResult {
  selectedAssetIds: string[]
  importedAssetIds: string[]
}

export class AudioImportBatchError extends Error {
  constructor(
    cause: unknown,
    readonly databaseWriteDispatched: boolean,
    readonly importedAssetIds: readonly string[]
  ) {
    super("Audio import batch did not complete", { cause })
    this.name = "AudioImportBatchError"
  }
}

export class AudioImportService {
  private readonly stagingDirectory: string

  constructor(
    userDataPath: string,
    private readonly projects: ProjectService
  ) {
    this.stagingDirectory = join(userDataPath, "media-import")
  }

  async import(paths: readonly string[], operationId: string): Promise<AudioImportBatchResult> {
    await mkdir(this.stagingDirectory, { recursive: true })
    const selectedAssetIds: string[] = []
    const importedAssetIds: string[] = []
    let databaseWriteDispatched = false
    try {
      for (const path of paths) {
        const assetId = randomUUID()
        const outputPath = join(this.stagingDirectory, `${assetId}.bwf`)
        try {
          const now = new Date().toISOString()
          const converted = await importAudioFile({
            inputPath: path,
            outputPath,
            assetId,
            originator: "Heron",
            originationDate: now.slice(0, 10),
            originationTime: now.slice(11, 19)
          })
          const existing = (await this.projects.listAssets()).find(
            (asset): asset is ProjectAudioAssetSummary =>
              asset.kind === "audio" && asset.contentHash === converted.contentHash
          )
          if (existing) {
            selectedAssetIds.push(existing.id)
            continue
          }
          databaseWriteDispatched = true
          await this.projects.importLargeObject(
            outputPath,
            operationId,
            {
              id: assetId,
              name: basename(path),
              mimeType: "audio/x-bwf",
              contentHash: converted.contentHash,
              sampleRate: converted.sampleRate,
              channels: converted.channels,
              bitDepth: "float32",
              frameCount: BigInt(converted.frameCount),
              bwfTimeReference: 0n,
              waveformLevels: converted.waveformLevels.map((level) => ({
                framesPerBucket: level.framesPerBucket,
                bucketCount: level.bucketCount,
                peaks: new Uint8Array(level.peaks)
              }))
            },
            () => undefined
          )
          selectedAssetIds.push(assetId)
          importedAssetIds.push(assetId)
          databaseWriteDispatched = false
        } finally {
          await rm(outputPath, { force: true })
        }
      }
    } catch (error) {
      throw new AudioImportBatchError(error, databaseWriteDispatched, [...importedAssetIds])
    }
    return { selectedAssetIds, importedAssetIds }
  }
}

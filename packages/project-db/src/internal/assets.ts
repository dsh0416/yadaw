import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { and, asc, eq, inArray, notExists, or } from "drizzle-orm"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import {
  closeLargeObject,
  createLargeObject,
  openLargeObject,
  readLargeObject as readLargeObjectData,
  unlinkLargeObject,
  writeLargeObject
} from "../large-object"
import type {
  AssetContentHash,
  DefaultRecordingTrack,
  LargeObjectAssetInput,
  StoredWaveformWindow,
  WaveformAssetInput
} from "../protocol"
import { WAVEFORM_CACHE_VERSION, assets, assetWaveformLevels, mixerChannels } from "../schema"
import * as schema from "../schema"
import { readWaveformWindow } from "../waveform"

type ProjectDb = PgliteDatabase<typeof schema>

export class ProjectAssetRepository {
  constructor(private readonly db: ProjectDb) {}

  async assetContentHashes(ids: string[]): Promise<AssetContentHash[]> {
    if (ids.length === 0) return []
    return this.db
      .select({
        id: assets.id,
        contentHash: assets.contentHash
      })
      .from(assets)
      .where(inArray(assets.id, ids))
  }

  async defaultRecordingTrack(): Promise<DefaultRecordingTrack | null> {
    const rows = await this.db
      .select({
        id: mixerChannels.id,
        name: mixerChannels.name,
        inputChannels: mixerChannels.inputChannels
      })
      .from(mixerChannels)
      .where(eq(mixerChannels.kind, "audio"))
      .orderBy(asc(mixerChannels.sortOrder), asc(mixerChannels.id))
      .limit(1)
    return rows[0] ?? null
  }

  assetsMissingWaveform(cacheVersion = WAVEFORM_CACHE_VERSION): Promise<string[]> {
    return this.db
      .select({ id: assets.id })
      .from(assets)
      .where(
        notExists(
          this.db
            .select({ assetId: assetWaveformLevels.assetId })
            .from(assetWaveformLevels)
            .where(
              and(
                eq(assetWaveformLevels.assetId, assets.id),
                eq(assetWaveformLevels.cacheVersion, cacheVersion)
              )
            )
        )
      )
      .orderBy(asc(assets.createdAt), asc(assets.id))
      .then((rows) => rows.map((row) => row.id))
  }

  async deleteAssets(ids: string[]): Promise<void> {
    if (ids.length === 0) return
    await this.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: assets.id,
          oid: assets.largeObjectOid
        })
        .from(assets)
        .where(inArray(assets.id, ids))
      await tx.delete(assets).where(inArray(assets.id, ids))
      for (const row of rows) await unlinkLargeObject(tx, row.oid)
    })
  }

  async importLargeObject(
    filePath: string,
    asset: LargeObjectAssetInput,
    onProgress?: (completed: number, total: number) => void,
    isCancelled?: () => boolean
  ): Promise<number> {
    const file = await stat(filePath)
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({
          id: assets.id,
          contentHash: assets.contentHash,
          largeObjectOid: assets.largeObjectOid
        })
        .from(assets)
        .where(or(eq(assets.id, asset.id), eq(assets.contentHash, asset.contentHash)))
        .limit(1)
      const existingAsset = existing[0]
      if (existingAsset) {
        if (existingAsset.id === asset.id && existingAsset.contentHash === asset.contentHash) {
          return existingAsset.largeObjectOid
        }
        throw new Error(`Audio asset conflicts with existing asset ${existingAsset.id}`)
      }

      const oid = await createLargeObject(tx)
      const descriptor = await openLargeObject(tx, oid)
      let completed = 0
      for await (const value of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
        if (isCancelled?.()) throw new Error("Operation cancelled")
        const chunk = value as Buffer
        await writeLargeObject(tx, descriptor, chunk)
        completed += chunk.byteLength
        onProgress?.(completed, file.size)
      }
      await closeLargeObject(tx, descriptor)

      await tx.insert(assets).values({
        id: asset.id,
        name: asset.name,
        mimeType: asset.mimeType,
        contentHash: asset.contentHash,
        byteLength: BigInt(file.size),
        sampleRate: asset.sampleRate,
        channels: asset.channels,
        bitDepth: asset.bitDepth,
        frameCount: asset.frameCount,
        bwfTimeReference: asset.bwfTimeReference,
        largeObjectOid: oid
      })
      if (asset.waveformLevels?.length) {
        await tx.insert(assetWaveformLevels).values(
          asset.waveformLevels.map((waveform, level) => ({
            assetId: asset.id,
            cacheVersion: WAVEFORM_CACHE_VERSION,
            level,
            framesPerBucket: waveform.framesPerBucket,
            bucketCount: waveform.bucketCount,
            channels: asset.channels,
            sampleRate: asset.sampleRate,
            frameCount: asset.frameCount,
            peaks: waveform.peaks
          }))
        )
      }
      return oid
    })
  }

  async readLargeObject(assetId: string): Promise<Uint8Array> {
    const rows = await this.db
      .select({
        oid: assets.largeObjectOid
      })
      .from(assets)
      .where(eq(assets.id, assetId))
      .limit(1)
    const row = rows[0]
    if (!row) throw new Error(`Audio asset '${assetId}' was not found`)
    return readLargeObjectData(this.db, row.oid)
  }

  async storeWaveform(assetId: string, waveform: WaveformAssetInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(assetWaveformLevels).where(eq(assetWaveformLevels.assetId, assetId))
      if (waveform.levels.length > 0) {
        await tx.insert(assetWaveformLevels).values(
          waveform.levels.map((value, level) => ({
            assetId,
            cacheVersion: WAVEFORM_CACHE_VERSION,
            level,
            framesPerBucket: value.framesPerBucket,
            bucketCount: value.bucketCount,
            channels: waveform.channels,
            sampleRate: waveform.sampleRate,
            frameCount: waveform.frameCount,
            peaks: value.peaks
          }))
        )
      }
    })
  }

  async readWaveform(
    assetId: string,
    startFrame: number,
    endFrame: number,
    maxBuckets: number
  ): Promise<StoredWaveformWindow | null> {
    return readWaveformWindow(
      this.db,
      assetId,
      WAVEFORM_CACHE_VERSION,
      startFrame,
      endFrame,
      maxBuckets
    )
  }
}

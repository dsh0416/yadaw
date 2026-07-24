import { createReadStream } from "node:fs"
import { open, readFile, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import type { PGliteInterface, Results } from "@electric-sql/pglite"
import { MIGRATION_JOURNAL_TABLE, PROJECT_MIGRATIONS } from "./migrations"
import type {
  ProjectQueryRequest,
  ProjectQueryResult,
  ProjectTransactionRequest,
  StoredWaveformWindow,
  WaveformAssetInput
} from "./protocol"
import { PROJECT_ID, PROJECT_SAMPLE_RATES } from "./schema"

export class ProjectCompatibilityError extends Error {
  constructor(
    message: string,
    readonly code: "newer-project" | "migration-conflict" | "corrupt-project"
  ) {
    super(message)
  }
}

interface JournalRow {
  id: string
  hash: string
}

function resultToProxy(result: Results<unknown>): ProjectQueryResult {
  const rows = Array.isArray(result.rows) ? result.rows as unknown[][] : []
  return { rows, rowCount: result.affectedRows ?? rows.length }
}

async function runQuery(db: Pick<PGliteInterface, "query">, request: ProjectQueryRequest): Promise<ProjectQueryResult> {
  const result = await db.query(request.sql, request.params, { rowMode: "array" })
  return resultToProxy(result)
}

export class ProjectDatabase {
  private constructor(private readonly db: PGlite) {}

  static async create(
    dataDir: string,
    project: {
      name: string
      sampleRate: number
      tempo: number
      numerator: number
      denominator: number
      waveformDisplayMode: "separate" | "aggregate"
    }
  ): Promise<ProjectDatabase> {
    if (!PROJECT_SAMPLE_RATES.includes(project.sampleRate as (typeof PROJECT_SAMPLE_RATES)[number])) {
      throw new RangeError("Unsupported project sample rate")
    }
    const instance = new ProjectDatabase(new PGlite(dataDir))
    try {
      await instance.migrate()
      await instance.db.query(
        `INSERT INTO project (
          id, name, sample_rate, tempo, time_signature_numerator,
          time_signature_denominator, waveform_display_mode
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          PROJECT_ID, project.name, project.sampleRate, project.tempo,
          project.numerator, project.denominator, project.waveformDisplayMode
        ]
      )
      return instance
    } catch (error) {
      await instance.close()
      throw error
    }
  }

  static async open(dataDir: string, archivePath?: string): Promise<ProjectDatabase> {
    if (archivePath) {
      const archive = await readFile(archivePath)
      const db = await PGlite.create({ dataDir, loadDataDir: new Blob([archive]) })
      const instance = new ProjectDatabase(db)
      try {
        await instance.migrate()
        return instance
      } catch (error) {
        await instance.close()
        throw error
      }
    }
    const instance = new ProjectDatabase(new PGlite(dataDir))
    try {
      await instance.migrate()
      return instance
    } catch (error) {
      await instance.close()
      throw error
    }
  }

  async migrate(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS ${MIGRATION_JOURNAL_TABLE} (
      id text PRIMARY KEY,
      hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`)
    const installed = await this.db.query<JournalRow>(
      `SELECT id, hash FROM ${MIGRATION_JOURNAL_TABLE} ORDER BY created_at, id`
    )
    if (installed.rows.length > PROJECT_MIGRATIONS.length) {
      throw new ProjectCompatibilityError("Project contains migrations newer than this application", "newer-project")
    }
    for (const [index, row] of installed.rows.entries()) {
      const expected = PROJECT_MIGRATIONS[index]
      if (!expected) {
        throw new ProjectCompatibilityError("Project contains an unknown migration", "newer-project")
      }
      if (row.id !== expected.id) {
        throw new ProjectCompatibilityError(`Unknown migration ${row.id}`, "newer-project")
      }
      if (row.hash !== expected.hash) {
        throw new ProjectCompatibilityError(`Migration ${row.id} has an unexpected hash`, "migration-conflict")
      }
    }
    for (const migration of PROJECT_MIGRATIONS.slice(installed.rows.length)) {
      await this.db.transaction(async (tx) => {
        for (const statement of migration.sql) await tx.exec(statement)
        await tx.query(
          `INSERT INTO ${MIGRATION_JOURNAL_TABLE} (id, hash) VALUES ($1, $2)`,
          [migration.id, migration.hash]
        )
      })
    }
  }

  query(request: ProjectQueryRequest): Promise<ProjectQueryResult> {
    return runQuery(this.db, request)
  }

  transaction(request: ProjectTransactionRequest): Promise<ProjectQueryResult[]> {
    return this.db.transaction(async (tx) => {
      const results: ProjectQueryResult[] = []
      for (const query of request.queries) results.push(await runQuery(tx, query))
      return results
    })
  }

  async importLargeObject(
    filePath: string,
    asset: {
      id: string
      name: string
      mimeType: "audio/x-bwf"
      contentHash: string
      sampleRate: number
      channels: number
      bitDepth: "float32" | "pcm24" | "pcm16"
      frameCount: bigint
      bwfTimeReference: bigint
      waveformLevels?: Array<{ framesPerBucket: number; bucketCount: number; peaks: Uint8Array }>
    },
    onProgress?: (completed: number, total: number) => void,
    isCancelled?: () => boolean
  ): Promise<number> {
    const file = await stat(filePath)
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: string; content_hash: string; large_object_oid: number }>(
        `SELECT id, content_hash, large_object_oid
         FROM assets
         WHERE id = $1 OR content_hash = $2
         LIMIT 1`,
        [asset.id, asset.contentHash]
      )
      const existingAsset = existing.rows[0]
      if (existingAsset) {
        if (existingAsset.id === asset.id && existingAsset.content_hash === asset.contentHash) {
          return Number(existingAsset.large_object_oid)
        }
        throw new Error(`Audio asset conflicts with existing asset ${existingAsset.id}`)
      }
      const created = await tx.query<{ oid: number }>("SELECT lo_create(0) AS oid")
      const oid = Number(created.rows[0]?.oid)
      const opened = await tx.query<{ descriptor: number }>("SELECT lo_open($1, 131072) AS descriptor", [oid])
      const descriptor = Number(opened.rows[0]?.descriptor)
      let completed = 0
      for await (const value of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
        if (isCancelled?.()) throw new Error("Operation cancelled")
        const chunk = value as Buffer
        await tx.query("SELECT lowrite($1, $2)", [descriptor, chunk])
        completed += chunk.byteLength
        onProgress?.(completed, file.size)
      }
      await tx.query("SELECT lo_close($1)", [descriptor])
      await tx.query(
        `INSERT INTO assets (
          id, name, mime_type, content_hash, byte_length, sample_rate, channels, bit_depth,
          frame_count, bwf_time_reference, large_object_oid
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          asset.id, asset.name, asset.mimeType, asset.contentHash, file.size, asset.sampleRate,
          asset.channels, asset.bitDepth, asset.frameCount, asset.bwfTimeReference, oid
        ]
      )
      for (const [level, waveform] of (asset.waveformLevels ?? []).entries()) {
        await tx.query(
          `INSERT INTO asset_waveform_levels (
            asset_id, cache_version, level, frames_per_bucket, bucket_count,
            channels, sample_rate, frame_count, peaks
          ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            asset.id, level, waveform.framesPerBucket, waveform.bucketCount,
            asset.channels, asset.sampleRate, asset.frameCount, waveform.peaks
          ]
        )
      }
      return oid
    })
  }

  async readLargeObject(assetId: string): Promise<Uint8Array> {
    const result = await this.db.query<{ data: Uint8Array }>(
      `SELECT lo_get(large_object_oid) AS data
       FROM assets
       WHERE id = $1`,
      [assetId]
    )
    const data = result.rows[0]?.data
    if (!data) throw new Error(`Audio asset '${assetId}' was not found`)
    return new Uint8Array(data)
  }

  async storeWaveform(assetId: string, waveform: WaveformAssetInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM asset_waveform_levels WHERE asset_id = $1",
        [assetId]
      )
      for (const [level, value] of waveform.levels.entries()) {
        await tx.query(
          `INSERT INTO asset_waveform_levels (
            asset_id, cache_version, level, frames_per_bucket, bucket_count,
            channels, sample_rate, frame_count, peaks
          ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            assetId, level, value.framesPerBucket, value.bucketCount,
            waveform.channels, waveform.sampleRate, waveform.frameCount, value.peaks
          ]
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
    const result = await this.db.query<{
      frames_per_bucket: number
      bucket_count: number
      channels: number
      sample_rate: number
      frame_count: string
      peaks: Uint8Array
    }>(
      `SELECT frames_per_bucket, bucket_count, channels, sample_rate, frame_count, peaks
       FROM asset_waveform_levels
       WHERE asset_id = $1 AND cache_version = 1
       ORDER BY frames_per_bucket`,
      [assetId]
    )
    if (result.rows.length === 0) return null
    const target = Math.max(1, Math.ceil((endFrame - startFrame) / Math.max(1, maxBuckets)))
    const selected = [...result.rows].reverse()
      .find((level) => level.frames_per_bucket <= target) ?? result.rows[0]!
    const frameCount = Number(selected.frame_count)
    const start = Math.max(0, Math.min(frameCount, startFrame))
    const end = Math.max(start, Math.min(frameCount, endFrame))
    const firstBucket = Math.floor(start / selected.frames_per_bucket)
    const lastBucket = Math.min(
      selected.bucket_count,
      Math.ceil(end / selected.frames_per_bucket)
    )
    const bytesPerBucket = selected.channels * 8
    const peaks = new Uint8Array(selected.peaks).slice(
      firstBucket * bytesPerBucket,
      lastBucket * bytesPerBucket
    )
    return {
      sampleRate: selected.sample_rate,
      channels: selected.channels,
      frameCount,
      startFrame: firstBucket * selected.frames_per_bucket,
      endFrame: Math.min(frameCount, lastBucket * selected.frames_per_bucket),
      framesPerBucket: selected.frames_per_bucket,
      bucketCount: lastBucket - firstBucket,
      peaks
    }
  }

  async dumpTo(outputPath: string): Promise<void> {
    const dump = await this.db.dumpDataDir("none")
    const handle = await open(outputPath, "w")
    try {
      await handle.writeFile(Buffer.from(await dump.arrayBuffer()))
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      const directory = await open(dirname(outputPath), "r")
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== "EPERM" && code !== "EINVAL") throw error
    }
  }

  async close(): Promise<void> {
    await this.db.close()
  }

  static async discardWorkingCopy(dataDir: string): Promise<void> {
    await rm(dataDir, { recursive: true, force: true })
  }
}

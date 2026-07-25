import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectDatabase } from "../node"
import { createProjectDbProxy } from "../proxy"
import { assets, project } from "../schema"

const databases: ProjectDatabase[] = []

function encodePeaks(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}

async function createDatabase(name = "Test project") {
  const directory = await mkdtemp(join(tmpdir(), "yadaw-project-db-"))
  const database = await ProjectDatabase.create(join(directory, "pgdata"), {
    name,
    sampleRate: 48_000,
    tempo: 120,
    numerator: 4,
    denominator: 4,
    waveformDisplayMode: "separate"
  })
  databases.push(database)
  return { database, directory }
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()))
})

describe("ProjectDatabase", () => {
  it("creates a migrated project and returns array rows for pg-proxy", async () => {
    const { database } = await createDatabase()
    const result = await database.query({
      sql: "SELECT name, sample_rate, tempo FROM project",
      params: [],
      method: "all"
    })

    expect(result.rows).toEqual([["Test project", 48_000, 120]])

    const proxy = createProjectDbProxy({ query: (request) => database.query(request) })
    const typed = await proxy.select().from(project)
    expect(typed[0]).toMatchObject({
      name: "Test project",
      sampleRate: 48_000,
      tempo: 120,
      waveformDisplayMode: "separate"
    })
    const mixer = await database.query({
      sql: `SELECT id, kind, color, input_format, output_channel_id, hardware_output_channels
        FROM mixer_channels ORDER BY kind`,
      params: [],
      method: "all"
    })
    expect(mixer.rows).toEqual([
      ["audio-1", "audio", "#4F8CFF", "stereo", "output-1-2", []],
      ["master", "master", "#8C83FF", null, null, []],
      ["output-1-2", "output", "#EF7C95", null, null, [1, 2]]
    ])
  })

  it("rolls an entire query batch back when one statement fails", async () => {
    const { database } = await createDatabase()
    await expect(database.transaction({ queries: [
      { sql: "UPDATE project SET tempo = 90", params: [], method: "execute" },
      { sql: "INSERT INTO missing_table VALUES (1)", params: [], method: "execute" }
    ] })).rejects.toThrow()

    const result = await database.query({ sql: "SELECT tempo FROM project", params: [], method: "all" })
    expect(result.rows).toEqual([[120]])
  })

  it("supports transactional large objects, sparse seek, rollback, and unlink trigger", async () => {
    const { database } = await createDatabase()
    const [created, opened, written, sought, sparseWritten, closed] = await database.transaction({ queries: [
      { sql: "SELECT lo_create(0)", params: [], method: "all" },
      { sql: "SELECT lo_open((SELECT oid FROM pg_largeobject_metadata LIMIT 1), 131072)", params: [], method: "all" },
      { sql: "SELECT lowrite(0, $1)", params: [new Uint8Array([1, 2, 3, 4])], method: "all" },
      { sql: "SELECT lo_lseek64(0, $1, 0)", params: [1_073_741_947], method: "all" },
      { sql: "SELECT lowrite(0, $1)", params: [new Uint8Array([9])], method: "all" },
      { sql: "SELECT lo_close(0)", params: [], method: "all" }
    ] })
    expect(created?.rows[0]?.[0]).toEqual(expect.any(Number))
    expect(opened?.rows).toEqual([[0]])
    expect(written?.rows).toEqual([[4]])
    expect(sought?.rows).toEqual([[1_073_741_947]])
    expect(sparseWritten?.rows).toEqual([[1]])
    expect(closed?.rows).toEqual([[0]])

    const oid = Number(created?.rows[0]?.[0])
    await database.query({
      sql: `INSERT INTO assets VALUES ($1, 'test.wav', 'audio/x-bwf', 'hash', 5, 48000, 2, 'float32', 1, 0, $2, now())`,
      params: ["asset", oid],
      method: "execute"
    })
    await database.query({ sql: "DELETE FROM assets WHERE id = 'asset'", params: [], method: "execute" })
    const removed = await database.query({
      sql: "SELECT count(*)::int FROM pg_largeobject_metadata WHERE oid = $1",
      params: [oid],
      method: "all"
    })
    expect(removed.rows).toEqual([[0]])

    await expect(database.transaction({ queries: [
      { sql: "SELECT lo_create(0)", params: [], method: "all" },
      { sql: "SELECT definitely_missing_function()", params: [], method: "all" }
    ] })).rejects.toThrow()
    const count = await database.query({
      sql: "SELECT count(*)::int FROM pg_largeobject_metadata",
      params: [],
      method: "all"
    })
    expect(count.rows).toEqual([[0]])
  })

  it("round-trips an uncompressed data-dir archive", async () => {
    const { database, directory } = await createDatabase("Archived")
    const archive = join(directory, "project.yadaw")
    await database.dumpTo(archive)
    expect((await readFile(archive)).byteLength).toBeGreaterThan(0)
    await database.close()
    databases.splice(databases.indexOf(database), 1)

    const restored = await ProjectDatabase.open(join(directory, "restored"), archive)
    databases.push(restored)
    const result = await restored.query({ sql: "SELECT name FROM project", params: [], method: "all" })
    expect(result.rows).toEqual([["Archived"]])
  })

  it("streams a final BWF into an LO and deletes it with the asset", async () => {
    const { database, directory } = await createDatabase()
    const audio = join(directory, "final.wav")
    await writeFile(audio, Buffer.alloc(2_500_000, 0x5a))
    const progress: number[] = []
    const oid = await database.importLargeObject(audio, {
      id: "recording",
      name: "Recording.wav",
      mimeType: "audio/x-bwf",
      contentHash: "sha256",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32",
      frameCount: 312_500n,
      bwfTimeReference: 0n
    }, (completed) => progress.push(completed))
    expect(progress.at(-1)).toBe(2_500_000)
    const asset = await database.query({
      sql: "SELECT large_object_oid, byte_length::bigint FROM assets WHERE id = 'recording'",
      params: [],
      method: "all"
    })
    expect(asset.rows).toEqual([[oid, 2_500_000]])
    const restoredAudio = await database.readLargeObject("recording")
    expect(restoredAudio).toHaveLength(2_500_000)
    expect(restoredAudio.slice(0, 4)).toEqual(new Uint8Array([0x5a, 0x5a, 0x5a, 0x5a]))
    await expect(database.readLargeObject("missing")).rejects.toThrow("was not found")
    const proxy = createProjectDbProxy({ query: (request) => database.query(request) })
    const typed = await proxy.select().from(assets)
    expect(typed[0]).toMatchObject({
      id: "recording",
      largeObjectOid: oid,
      byteLength: 2_500_000n,
      createdAt: expect.any(Date)
    })
  })

  it("stores, slices, selects, archives, and cascade-deletes arbitrary-channel waveform levels", async () => {
    const { database, directory } = await createDatabase()
    const audio = join(directory, "surround.wav")
    const archive = join(directory, "surround.yadaw")
    await writeFile(audio, Buffer.alloc(256, 0x22))
    const baseValues = [
      -0.125, 0.125, -0.25, 0.25, -0.375, 0.375,
      -0.5, 0.5, -0.625, 0.625, -0.75, 0.75,
      -0.875, 0.875, -1, 1, -0.25, 0.25,
      -0.75, 0.75, -0.5, 0.5, -0.125, 0.125
    ]
    await database.importLargeObject(audio, {
      id: "surround",
      name: "Surround.wav",
      mimeType: "audio/x-bwf",
      contentHash: "surround-hash",
      sampleRate: 96_000,
      channels: 3,
      bitDepth: "pcm24",
      frameCount: 256n,
      bwfTimeReference: 0n,
      waveformLevels: [
        { framesPerBucket: 64, bucketCount: 4, peaks: encodePeaks(baseValues) },
        {
          framesPerBucket: 256,
          bucketCount: 1,
          peaks: encodePeaks([-0.875, 0.875, -1, 1, -0.75, 0.75])
        }
      ]
    })

    const detail = await database.readWaveform("surround", 64, 192, 100)
    expect(detail).toMatchObject({
      channels: 3,
      startFrame: 64,
      endFrame: 192,
      framesPerBucket: 64,
      bucketCount: 2
    })
    expect(detail?.peaks).toEqual(encodePeaks(baseValues.slice(6, 18)))
    const overview = await database.readWaveform("surround", 0, 256, 1)
    expect(overview).toMatchObject({ framesPerBucket: 256, bucketCount: 1 })

    await database.dumpTo(archive)
    await database.close()
    databases.splice(databases.indexOf(database), 1)
    const restored = await ProjectDatabase.open(join(directory, "restored-waveform"), archive)
    databases.push(restored)
    expect(await restored.readWaveform("surround", 0, 256, 1)).toMatchObject({
      channels: 3,
      frameCount: 256,
      framesPerBucket: 256,
      bucketCount: 1
    })
    await restored.query({
      sql: "DELETE FROM assets WHERE id = 'surround'",
      params: [],
      method: "execute"
    })
    const cached = await restored.query({
      sql: "SELECT count(*)::int FROM asset_waveform_levels WHERE asset_id = 'surround'",
      params: [],
      method: "all"
    })
    expect(cached.rows).toEqual([[0]])
  })

  it("treats an outdated cache version as missing and rolls cache/import failures back together", async () => {
    const { database, directory } = await createDatabase()
    const audio = join(directory, "rollback.wav")
    await writeFile(audio, Buffer.alloc(64, 0x11))
    const base = {
      name: "Rollback.wav",
      mimeType: "audio/x-bwf" as const,
      contentHash: "rollback-hash",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32" as const,
      frameCount: 64n,
      bwfTimeReference: 0n
    }
    await expect(database.importLargeObject(audio, {
      id: "broken",
      ...base,
      waveformLevels: [{ framesPerBucket: 64, bucketCount: 1, peaks: new Uint8Array(1) }]
    })).rejects.toThrow()
    expect((await database.query({
      sql: "SELECT count(*)::int FROM assets WHERE id = 'broken'",
      params: [],
      method: "all"
    })).rows).toEqual([[0]])
    expect((await database.query({
      sql: "SELECT count(*)::int FROM pg_largeobject_metadata",
      params: [],
      method: "all"
    })).rows).toEqual([[0]])

    await database.importLargeObject(audio, {
      id: "versioned",
      ...base,
      contentHash: "versioned-hash",
      waveformLevels: [{
        framesPerBucket: 64,
        bucketCount: 1,
        peaks: encodePeaks([-0.5, 0.5, -0.25, 0.25])
      }]
    })
    await database.query({
      sql: "UPDATE asset_waveform_levels SET cache_version = 99 WHERE asset_id = 'versioned'",
      params: [],
      method: "execute"
    })
    expect(await database.readWaveform("versioned", 0, 64, 10)).toBeNull()
  })

  it("rolls back a cancelled or duplicate LO import without leaving an orphan", async () => {
    const { database, directory } = await createDatabase()
    const audio = join(directory, "cancelled.wav")
    await writeFile(audio, Buffer.alloc(1_500_000, 0x31))
    const base = {
      name: "Recording.wav",
      mimeType: "audio/x-bwf" as const,
      contentHash: "same-hash",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32" as const,
      frameCount: 187_500n,
      bwfTimeReference: 0n
    }
    await expect(database.importLargeObject(audio, { id: "cancelled", ...base }, undefined, () => true))
      .rejects.toThrow("cancelled")
    let count = await database.query({
      sql: "SELECT count(*)::int FROM pg_largeobject_metadata",
      params: [], method: "all"
    })
    expect(count.rows).toEqual([[0]])

    await database.importLargeObject(audio, { id: "first", ...base })
    const existingOid = await database.importLargeObject(audio, { id: "first", ...base })
    const original = await database.query({
      sql: "SELECT large_object_oid FROM assets WHERE id = 'first'",
      params: [], method: "all"
    })
    expect(existingOid).toBe(original.rows[0]?.[0])
    await expect(database.importLargeObject(audio, { id: "duplicate", ...base })).rejects.toThrow()
    count = await database.query({
      sql: "SELECT count(*)::int FROM pg_largeobject_metadata",
      params: [], method: "all"
    })
    expect(count.rows).toEqual([[1]])
  })

  it("rejects a known migration id with a conflicting hash", async () => {
    const { database, directory } = await createDatabase()
    await database.query({
      sql: "UPDATE __drizzle_migrations SET hash = 'tampered' WHERE id = '0000_initial'",
      params: [],
      method: "execute"
    })
    await database.close()
    databases.splice(databases.indexOf(database), 1)
    await expect(ProjectDatabase.open(join(directory, "pgdata"))).rejects.toMatchObject({
      code: "migration-conflict"
    })
  })

  it("rejects a project with an unknown newer migration", async () => {
    const { database, directory } = await createDatabase()
    await database.query({
      sql: "INSERT INTO __drizzle_migrations (id, hash) VALUES ('9999_future', 'future')",
      params: [],
      method: "execute"
    })
    await database.close()
    databases.splice(databases.indexOf(database), 1)
    await expect(ProjectDatabase.open(join(directory, "pgdata"))).rejects.toMatchObject({
      code: "newer-project"
    })
  })
})

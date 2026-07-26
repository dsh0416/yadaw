import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import type { MixerChannelState, ProjectCommand } from "@yadaw/contracts"
import { afterEach, describe, expect, it } from "vitest"
import { ProjectDatabase } from "../node"

interface TestDatabase {
  database: ProjectDatabase
  directory: string
}

const databases: TestDatabase[] = []

function encodePeaks(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}

async function createDatabase(name = "Test project"): Promise<TestDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "yadaw-project-db-"))
  const database = await ProjectDatabase.create(join(directory, "pgdata"), {
    name,
    sampleRate: 48_000,
    numerator: 4,
    denominator: 4,
    waveformDisplayMode: "separate"
  })
  const result = { database, directory }
  databases.push(result)
  return result
}

afterEach(async () => {
  for (const resource of databases.splice(0)) {
    await resource.database.close()
    await rm(resource.directory, { force: true, recursive: true })
  }
})

describe("ProjectDatabase", () => {
  it("runs generated migrations, seeds the graph, and updates normalized configuration", async () => {
    const { database } = await createDatabase()

    await database.migrate()
    expect(await database.getConfiguration()).toEqual({
      name: "Test project",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })
    expect(await database.defaultRecordingTrack()).toEqual({
      id: "audio-1",
      name: "Audio 1",
      inputChannels: [1, 2]
    })

    const seeded = await database.mixerSnapshot()
    expect(seeded.channels.map(({ id }) => id)).toEqual(["audio-1", "master", "output-1-2"])
    expect(seeded.tempoMap).toEqual({
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    })

    await database.updateConfiguration({
      name: "Renamed",
      sampleRate: 44_100,
      timeSignatureNumerator: 7,
      timeSignatureDenominator: 8,
      waveformDisplayMode: "aggregate"
    })
    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "audio-1",
        patch: {}
      },
      "output-1-2"
    )

    expect(await database.getConfiguration()).toEqual({
      name: "Renamed",
      sampleRate: 44_100,
      timeSignatureNumerator: 7,
      timeSignatureDenominator: 8,
      waveformDisplayMode: "aggregate"
    })
    expect((await database.mixerSnapshot()).tempoMap.timeSignatureEvents[0]).toEqual({
      tick: 0,
      numerator: 7,
      denominator: 8
    })
  })

  it("enforces relations and rolls back failed command batches", async () => {
    const { database } = await createDatabase()
    const bus: MixerChannelState = {
      id: "bus-1",
      kind: "bus",
      name: "Bus 1",
      color: "#112233",
      sortOrder: 0,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: "output-1-2",
      recordArmed: false,
      inputChannels: [],
      hardwareOutputChannels: []
    }

    await database.applyCommand({ type: "create-channel", channel: bus }, "output-1-2")
    await database.applyCommand(
      {
        type: "create-send",
        send: {
          id: "post-pan-send",
          sourceChannelId: "audio-1",
          targetChannelId: bus.id,
          sortOrder: 0,
          enabled: true,
          tap: "post-pan",
          levelDb: -3,
          pan: 0.25
        }
      },
      "output-1-2"
    )
    expect((await database.mixerSnapshot()).sends).toContainEqual(
      expect.objectContaining({ id: "post-pan-send", tap: "post-pan" })
    )
    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "audio-1",
        patch: { outputChannelId: bus.id }
      },
      "output-1-2"
    )
    await database.applyCommand({ type: "delete-channel", channelId: bus.id }, "output-1-2")
    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({ outputChannelId: "output-1-2" })

    const invalidBatch: ProjectCommand = {
      type: "batch",
      commands: [
        { type: "create-channel", channel: { ...bus, id: "rolled-back-bus" } },
        {
          type: "create-send",
          send: {
            id: "invalid-send",
            sourceChannelId: "missing-channel",
            targetChannelId: "output-1-2",
            sortOrder: 0,
            enabled: true,
            tap: "post",
            levelDb: 0,
            pan: 0
          }
        }
      ]
    }
    await expect(database.applyCommand(invalidBatch, "output-1-2")).rejects.toThrow()
    expect((await database.mixerSnapshot()).channels).not.toContainEqual(
      expect.objectContaining({ id: "rolled-back-bus" })
    )

    await expect(
      database.applyCommand(
        {
          type: "replace-tempo-map",
          tempoMap: {
            ticksPerQuarter: 960,
            tempoEvents: [{ tick: 240, beatsPerMinute: 90 }],
            timeSignatureEvents: [{ tick: 0, numerator: 3, denominator: 4 }]
          }
        },
        "output-1-2"
      )
    ).rejects.toThrow("tick 0")
    expect((await database.mixerSnapshot()).tempoMap.tempoEvents).toEqual([
      { tick: 0, beatsPerMinute: 120 }
    ])
  })

  it("persists assets, waveform caches, and large objects through an archive", async () => {
    const { database, directory } = await createDatabase()
    const audioPath = join(directory, "audio.bwf")
    const archivePath = join(directory, "project.dump")
    const audio = new Uint8Array([1, 3, 5, 7, 9, 11])
    await writeFile(audioPath, audio)

    await database.importLargeObject(audioPath, {
      id: "asset-1",
      name: "Audio",
      mimeType: "audio/x-bwf",
      contentHash: "hash-1",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32",
      frameCount: 2n,
      bwfTimeReference: 0n,
      waveformLevels: [
        {
          framesPerBucket: 2,
          bucketCount: 1,
          peaks: encodePeaks([-1, 1, -0.5, 0.5])
        }
      ]
    })

    expect(await database.readLargeObject("asset-1")).toEqual(audio)
    expect(await database.listAssets()).toEqual([
      {
        id: "asset-1",
        name: "Audio",
        sampleRate: 48_000,
        channels: 2,
        bitDepth: "float32",
        frameCount: 2n
      }
    ])
    expect(await database.assetsMissingWaveform()).toEqual([])
    expect(await database.readWaveform("asset-1", 0, 2, 100)).toMatchObject({
      sampleRate: 48_000,
      channels: 2,
      frameCount: 2,
      framesPerBucket: 2,
      bucketCount: 1
    })

    await database.dumpTo(archivePath)
    expect([...(await readFile(archivePath)).subarray(0, 2)]).not.toEqual([0x1f, 0x8b])
    const restoredDirectory = await mkdtemp(join(tmpdir(), "yadaw-project-db-restored-"))
    const restored = await ProjectDatabase.open(join(restoredDirectory, "pgdata"), archivePath)
    databases.push({ database: restored, directory: restoredDirectory })

    expect(await restored.readLargeObject("asset-1")).toEqual(audio)
    await restored.storeWaveform("asset-1", {
      sampleRate: 48_000,
      channels: 2,
      frameCount: 2n,
      levels: []
    })
    expect(await restored.assetsMissingWaveform()).toEqual(["asset-1"])
    await restored.deleteAssets(["asset-1"])
    expect(await restored.listAssets()).toEqual([])
    await expect(restored.readLargeObject("asset-1")).rejects.toThrow("was not found")
  }, 15_000)

  it("reclaims orphaned large objects before writing the archive", async () => {
    const resource = await createDatabase()
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await raw.query("select lo_from_bytea(0, $1)", [new Uint8Array([1, 2, 3, 4])])
      const before = await raw.query<{ count: number }>(
        "select count(*)::int as count from pg_catalog.pg_largeobject_metadata"
      )
      expect(before.rows[0]?.count).toBe(1)
    } finally {
      await raw.close()
    }

    const database = await ProjectDatabase.open(join(resource.directory, "pgdata"))
    databases.push({ database, directory: resource.directory })
    const archivePath = join(resource.directory, "maintained-project.dump")
    await database.dumpTo(archivePath)

    const verificationDirectory = await mkdtemp(join(tmpdir(), "yadaw-maintained-archive-"))
    const verifier = await PGlite.create({
      dataDir: join(verificationDirectory, "pgdata"),
      loadDataDir: new Blob([await readFile(archivePath)])
    })
    try {
      const after = await verifier.query<{ count: number }>(
        "select count(*)::int as count from pg_catalog.pg_largeobject_metadata"
      )
      expect(after.rows[0]?.count).toBe(0)
    } finally {
      await verifier.close()
      await rm(verificationDirectory, { force: true, recursive: true })
    }
  }, 15_000)

  it("rolls back a cancelled large-object import", async () => {
    const { database, directory } = await createDatabase()
    const audioPath = join(directory, "cancelled.bwf")
    await writeFile(audioPath, new Uint8Array([1, 2, 3, 4]))

    await expect(
      database.importLargeObject(
        audioPath,
        {
          id: "cancelled",
          name: "Cancelled",
          mimeType: "audio/x-bwf",
          contentHash: "cancelled-hash",
          sampleRate: 48_000,
          channels: 1,
          bitDepth: "pcm16",
          frameCount: 2n,
          bwfTimeReference: 0n
        },
        undefined,
        () => true
      )
    ).rejects.toThrow("cancelled")
    expect(await database.listAssets()).toEqual([])
  })
})

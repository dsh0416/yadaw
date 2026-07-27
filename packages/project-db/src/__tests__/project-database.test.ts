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

async function revertAuxBusMigration(database: PGlite): Promise<void> {
  await database.exec(`
    drop index "mixer_sends_source_bus_unique";
    drop index "mixer_sends_source_output_unique";
    alter table "mixer_sends" drop constraint "mixer_sends_target_check";
    alter table "mixer_sends" alter column "target_channel_id" set not null;
    alter table "mixer_sends"
      add constraint "mixer_sends_distinct_channels_check"
      check ("source_channel_id" <> "target_channel_id");
    create unique index "mixer_sends_source_target_unique"
      on "mixer_sends" ("source_channel_id", "target_channel_id");
    alter table "mixer_sends" drop column "target_bus";

    alter table "mixer_channels" drop constraint "mixer_channels_kind_check";
    alter table "mixer_channels" drop constraint "mixer_channels_output_route_check";
    alter table "mixer_channels" drop constraint "mixer_channels_output_bus_check";
    alter table "mixer_channels" drop constraint "mixer_channels_input_check";
    alter table "mixer_channels" drop constraint "mixer_channels_input_channels_check";
    update "mixer_channels"
      set "kind" = 'bus',
          "input_format" = null,
          "input_channels" = array[]::smallint[],
          "record_armed" = false
      where "kind" = 'aux';
    alter table "mixer_channels" drop column "input_source";
    alter table "mixer_channels" drop column "output_bus";
    alter table "mixer_channels"
      add constraint "mixer_channels_kind_check"
      check ("kind" in ('audio', 'instrument', 'bus', 'master', 'output'));
    alter table "mixer_channels"
      add constraint "mixer_channels_output_route_check"
      check (("kind" in ('master', 'output')) = ("output_channel_id" is null));
    alter table "mixer_channels"
      add constraint "mixer_channels_input_check"
      check ((
        "kind" = 'audio'
        and "input_format" is not null
        and (
          ("input_format" = 'mono' and cardinality("input_channels") = 1)
          or ("input_format" = 'stereo' and cardinality("input_channels") = 2)
        )
      ) or (
        "kind" <> 'audio'
        and "input_format" is null
        and cardinality("input_channels") = 0
        and not "record_armed"
      ));
    alter table "mixer_channels"
      add constraint "mixer_channels_input_channels_check"
      check (0 < all("input_channels"));
  `)
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
    expect(seeded.channels.map(({ id }) => id)).toEqual([
      "audio-1",
      "metronome",
      "master",
      "output-1-2"
    ])
    expect(seeded.channels.find(({ id }) => id === "metronome")).toMatchObject({
      kind: "instrument",
      systemRole: "metronome",
      muted: true,
      outputChannelId: "output-1-2"
    })
    expect(seeded.plugins.find(({ id }) => id === "metronome-instrument")).toMatchObject({
      channelId: "metronome",
      classId: "F310A5DEDA34820C9E068A5753F83ADE",
      role: "instrument",
      descriptor: {
        source: { kind: "builtin", id: "dev.yadaw.metronome" }
      }
    })
    expect(seeded.tempoMap).toEqual({
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    })
    expect(seeded.keySignatureEvents).toEqual([{ tick: 0, fifths: 0, mode: "major" }])

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
    await database.applyCommand(
      {
        type: "replace-key-signature-map",
        events: [
          { tick: 0, fifths: 2, mode: "major" },
          { tick: 3_840, fifths: -7, mode: "minor" }
        ]
      },
      "output-1-2"
    )
    expect((await database.mixerSnapshot()).keySignatureEvents).toEqual([
      { tick: 0, fifths: 2, mode: "major" },
      { tick: 3_840, fifths: -7, mode: "minor" }
    ])
  })

  it("migrates legacy bus channels while preserving main and send BUS targets", async () => {
    const resource = await createDatabase()
    await resource.database.applyCommand(
      {
        type: "create-channel",
        channel: {
          id: "legacy-bus",
          kind: "aux",
          systemRole: null,
          name: "Legacy Bus",
          color: "#112233",
          sortOrder: 6,
          inputSource: "bus",
          inputFormat: "mono",
          gainDb: 0,
          pan: 0,
          muted: false,
          soloed: false,
          outputChannelId: "output-1-2",
          recordArmed: false,
          inputChannels: [7],
          hardwareOutputChannels: []
        }
      },
      "output-1-2"
    )
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await revertAuxBusMigration(raw)
      await raw.exec(`
        update "mixer_channels"
          set "output_channel_id" = 'legacy-bus'
          where "id" = 'audio-1';
        insert into "mixer_sends" (
          "id", "source_channel_id", "target_channel_id",
          "sort_order", "enabled", "tap", "level_db"
        ) values (
          'legacy-send', 'metronome', 'legacy-bus',
          0, true, 'post-pan', -6
        );
        delete from drizzle.__drizzle_migrations
        where created_at = (
          select created_at
          from drizzle.__drizzle_migrations
          order by created_at desc
          limit 1
        );
      `)
    } finally {
      await raw.close()
    }

    const migrated = await ProjectDatabase.open(join(resource.directory, "pgdata"))
    databases.push({ database: migrated, directory: resource.directory })
    const snapshot = await migrated.mixerSnapshot()
    expect(snapshot.channels.find(({ id }) => id === "legacy-bus")).toMatchObject({
      kind: "aux",
      inputSource: "bus",
      inputFormat: "mono",
      inputChannels: [7],
      outputChannelId: "output-1-2"
    })
    expect(snapshot.channels.find(({ id }) => id === "audio-1")).toMatchObject({
      outputChannelId: null,
      outputBus: 7
    })
    expect(snapshot.sends).toContainEqual(
      expect.objectContaining({
        id: "legacy-send",
        sourceChannelId: "metronome",
        targetChannelId: null,
        targetBus: 7,
        enabled: true,
        tap: "post-pan",
        levelDb: -6
      })
    )
  })

  it("enforces relations and rolls back failed command batches", async () => {
    const { database } = await createDatabase()
    const aux: MixerChannelState = {
      id: "aux-1",
      kind: "aux",
      systemRole: null,
      name: "Aux 1",
      color: "#112233",
      sortOrder: 0,
      inputSource: "bus",
      inputFormat: "mono",
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: "output-1-2",
      recordArmed: false,
      inputChannels: [7],
      hardwareOutputChannels: []
    }

    await database.applyCommand({ type: "create-channel", channel: aux }, "output-1-2")
    await database.applyCommand(
      {
        type: "create-send",
        send: {
          id: "post-pan-send",
          sourceChannelId: "audio-1",
          targetBus: 7,
          sortOrder: 0,
          enabled: true,
          tap: "post-pan",
          levelDb: -3
        }
      },
      "output-1-2"
    )
    const persistedSend = (await database.mixerSnapshot()).sends.find(
      (send) => send.id === "post-pan-send"
    )
    expect(persistedSend).toMatchObject({ id: "post-pan-send", tap: "post-pan" })
    expect(persistedSend).not.toHaveProperty("pan")
    await database.applyCommand({ type: "delete-channel", channelId: aux.id }, "output-1-2")
    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({ outputChannelId: "output-1-2" })

    const invalidBatch: ProjectCommand = {
      type: "batch",
      commands: [
        { type: "create-channel", channel: { ...aux, id: "rolled-back-aux" } },
        {
          type: "create-send",
          send: {
            id: "invalid-send",
            sourceChannelId: "missing-channel",
            targetBus: 8,
            sortOrder: 0,
            enabled: true,
            tap: "post",
            levelDb: 0
          }
        }
      ]
    }
    await expect(database.applyCommand(invalidBatch, "output-1-2")).rejects.toThrow()
    expect((await database.mixerSnapshot()).channels).not.toContainEqual(
      expect.objectContaining({ id: "rolled-back-aux" })
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
    await expect(
      database.applyCommand(
        {
          type: "replace-key-signature-map",
          events: [{ tick: 240, fifths: 0, mode: "major" }]
        },
        "output-1-2"
      )
    ).rejects.toThrow("tick 0")
  })

  it("persists metronome mute while protecting the system channel and clip boundary", async () => {
    const { database } = await createDatabase()
    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "metronome",
        patch: { muted: false, name: "Click" }
      },
      "output-1-2"
    )
    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "metronome")
    ).toMatchObject({
      name: "Click",
      muted: false,
      systemRole: "metronome"
    })

    await expect(
      database.applyCommand({ type: "delete-channel", channelId: "metronome" }, "output-1-2")
    ).rejects.toThrow("System channels cannot be deleted")
    await expect(
      database.applyCommand(
        {
          type: "batch",
          commands: [{ type: "delete-channel", channelId: "metronome" }]
        },
        "output-1-2"
      )
    ).rejects.toThrow("System channels cannot be deleted")
    await expect(
      database.applyCommand(
        {
          type: "create-midi-clip",
          clip: {
            id: "invalid-metronome-clip",
            sourceId: "missing-source",
            trackId: "metronome",
            name: "Invalid",
            startTick: 0,
            sourceOffsetTicks: 0,
            lengthTicks: 960,
            notes: [],
            events: []
          }
        },
        "output-1-2"
      )
    ).rejects.toThrow("System channels cannot contain clips")
    expect((await database.mixerSnapshot()).channels).toContainEqual(
      expect.objectContaining({ id: "metronome", systemRole: "metronome" })
    )
  })

  it("adds the default muted metronome exactly once when an older project is migrated", async () => {
    const resource = await createDatabase()
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await revertAuxBusMigration(raw)
      await raw.exec(`
        delete from "mixer_channels" where "id" = 'metronome';
        drop index "mixer_system_role_singleton";
        alter table "mixer_channels"
          drop constraint "mixer_channels_system_role_check";
        alter table "mixer_channels"
          drop constraint "mixer_channels_system_role_kind_check";
        alter table "mixer_channels" drop column "system_role";
        drop table "key_signature_events";
        delete from drizzle.__drizzle_migrations
        where created_at in (
          select created_at
          from drizzle.__drizzle_migrations
          order by created_at desc
          limit 5
        );
      `)
    } finally {
      await raw.close()
    }

    const migrated = await ProjectDatabase.open(join(resource.directory, "pgdata"))
    databases.push({ database: migrated, directory: resource.directory })
    const snapshot = await migrated.mixerSnapshot()
    expect(snapshot.channels.filter((channel) => channel.systemRole === "metronome")).toEqual([
      expect.objectContaining({
        id: "metronome",
        muted: true,
        outputChannelId: "output-1-2"
      })
    ])
    expect(snapshot.plugins.filter((plugin) => plugin.channelId === "metronome")).toEqual([
      expect.objectContaining({
        id: "metronome-instrument",
        classId: "F310A5DEDA34820C9E068A5753F83ADE"
      })
    ])
    expect(snapshot.keySignatureEvents).toEqual([{ tick: 0, fifths: 0, mode: "major" }])
  })

  it("migrates existing pitch-class key events to theory-aware fifths", async () => {
    const resource = await createDatabase()
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await revertAuxBusMigration(raw)
      await raw.exec(`
        alter table "key_signature_events"
          add column "pitch_class" smallint not null default 0;
        update "key_signature_events"
          set "pitch_class" = 1, "mode" = 'major'
          where "tick" = 0;
        insert into "key_signature_events" ("tick", "fifths", "mode", "pitch_class")
          values (3840, 0, 'minor', 8);
        alter table "key_signature_events"
          add constraint "key_signature_events_pitch_class_check"
          check ("pitch_class" between 0 and 11);
        alter table "key_signature_events"
          drop constraint "key_signature_events_fifths_check";
        alter table "key_signature_events" drop column "fifths";
        delete from drizzle.__drizzle_migrations
        where created_at in (
          select created_at
          from drizzle.__drizzle_migrations
          order by created_at desc
          limit 3
        );
      `)
    } finally {
      await raw.close()
    }

    const migrated = await ProjectDatabase.open(join(resource.directory, "pgdata"))
    databases.push({ database: migrated, directory: resource.directory })
    expect((await migrated.mixerSnapshot()).keySignatureEvents).toEqual([
      { tick: 0, fifths: 7, mode: "major" },
      { tick: 3_840, fifths: -7, mode: "minor" }
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

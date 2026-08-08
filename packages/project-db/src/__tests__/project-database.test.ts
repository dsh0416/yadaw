import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PGlite } from "@electric-sql/pglite"
import type { MixerChannelState, ProjectCommand } from "@heron/contracts"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { PROJECT_MIGRATIONS_FOLDER } from "../migrations"
import { ProjectDatabase } from "../node"
import { buildProjectTemplateArchive } from "../template"

interface TestDatabase {
  database: ProjectDatabase
  directory: string
}

const databases: TestDatabase[] = []
let templateDirectory: string
let templateArchivePath: string

function encodePeaks(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}

async function createDatabase(name = "Test project"): Promise<TestDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "heron-project-db-"))
  const database = await ProjectDatabase.create(
    join(directory, "pgdata"),
    {
      name,
      sampleRate: 48_000,
      numerator: 4,
      denominator: 4,
      waveformDisplayMode: "separate"
    },
    templateArchivePath
  )
  const result = { database, directory }
  databases.push(result)
  return result
}

async function revertTrackMigration(database: PGlite): Promise<void> {
  await database.exec(`
    alter table "midi_clips"
      drop constraint "midi_clips_track_id_tracks_id_fk";
    alter table "audio_clips"
      drop constraint "audio_clips_asset_id_assets_id_fk";
    alter table "audio_clips"
      drop constraint "audio_clips_track_id_tracks_id_fk";
    alter table "audio_clips" drop constraint "audio_clips_name_check";
    alter table "audio_clips" drop constraint "audio_clips_start_frame_check";
    alter table "audio_clips"
      drop constraint "audio_clips_source_offset_frames_check";
    alter table "audio_clips" drop constraint "audio_clips_length_frames_check";
    drop index "audio_clips_track_start";

    update "audio_clips"
      set "track_id" = substring("track_id" from 7);
    update "midi_clips"
      set "track_id" = substring("track_id" from 7);
    drop table "tracks";
    alter table "audio_clips" rename to "timeline_clips";

    alter table "timeline_clips"
      add constraint "timeline_clips_asset_id_assets_id_fk"
      foreign key ("asset_id") references "assets"("id") on delete cascade;
    alter table "timeline_clips"
      add constraint "timeline_clips_track_id_mixer_channels_id_fk"
      foreign key ("track_id") references "mixer_channels"("id") on delete cascade;
    alter table "midi_clips"
      add constraint "midi_clips_track_id_mixer_channels_id_fk"
      foreign key ("track_id") references "mixer_channels"("id") on delete cascade;
    create index "timeline_clips_track_start"
      on "timeline_clips" ("track_id", "start_frame");
    alter table "timeline_clips"
      add constraint "timeline_clips_name_check"
      check (length(trim("name")) > 0);
    alter table "timeline_clips"
      add constraint "timeline_clips_start_frame_check"
      check ("start_frame" >= 0);
    alter table "timeline_clips"
      add constraint "timeline_clips_source_offset_frames_check"
      check ("source_offset_frames" >= 0);
    alter table "timeline_clips"
      add constraint "timeline_clips_length_frames_check"
      check ("length_frames" > 0);

    delete from drizzle.__drizzle_migrations
    where created_at = (
      select created_at
      from drizzle.__drizzle_migrations
      order by created_at desc
      limit 1
    );
  `)
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

async function revertPluginAudioModeMigration(database: PGlite): Promise<void> {
  await database.exec(`
    alter table "plugin_instances"
      drop constraint "plugin_instances_audio_mode_check";
    alter table "plugin_instances" drop column "audio_mode";
  `)
}

async function revertMidiInputMigration(database: PGlite): Promise<void> {
  await database.exec(`
    alter table "mixer_channels" drop constraint "mixer_channels_record_armed_check";
    alter table "mixer_channels" drop constraint "mixer_channels_midi_input_check";
    alter table "mixer_channels" drop constraint "mixer_channels_input_monitoring_check";
    alter table "mixer_channels" drop constraint "mixer_channels_input_check";
    alter table "mixer_channels" drop column "midi_input_port_id";
    alter table "mixer_channels" drop column "midi_input_port_name";
    alter table "mixer_channels" drop column "midi_input_channel";
    alter table "mixer_channels"
      add constraint "mixer_channels_input_monitoring_check"
      check ("kind" = 'audio' or not "input_monitoring");
    alter table "mixer_channels"
      add constraint "mixer_channels_input_check"
      check ((
        "kind" in ('audio', 'aux')
        and "input_source" is not null
        and "input_format" is not null
        and (
          ("input_format" = 'mono' and cardinality("input_channels") = 1)
          or (
            "input_format" = 'stereo'
            and cardinality("input_channels") = 2
            and "input_channels"[1] <> "input_channels"[2]
          )
        )
        and ("kind" = 'audio' or not "record_armed")
      ) or (
        "kind" not in ('audio', 'aux')
        and "input_source" is null
        and "input_format" is null
        and cardinality("input_channels") = 0
        and not "record_armed"
      ));
    delete from drizzle.__drizzle_migrations
    where created_at = (
      select created_at
      from drizzle.__drizzle_migrations
      order by created_at desc
      limit 1
    );
  `)
}

async function revertInputMonitoringMigration(database: PGlite): Promise<void> {
  await database.exec(`
    alter table "mixer_channels"
      drop constraint "mixer_channels_input_monitoring_check";
    alter table "mixer_channels" drop column "input_monitoring";
    delete from drizzle.__drizzle_migrations
    where created_at = (
      select created_at
      from drizzle.__drizzle_migrations
      order by created_at desc
      limit 1
    );
  `)
}

async function revertAraDocumentStateMigration(database: PGlite): Promise<void> {
  await database.exec(`
    alter table "plugin_instances" drop column "ara_document_state";
    delete from drizzle.__drizzle_migrations
    where created_at = (
      select created_at
      from drizzle.__drizzle_migrations
      order by created_at desc
      limit 1
    );
  `)
}

beforeAll(async () => {
  templateDirectory = await mkdtemp(join(tmpdir(), "heron-project-template-test-"))
  templateArchivePath = join(templateDirectory, "project-template.pglite.gz")
  await buildProjectTemplateArchive(templateArchivePath, PROJECT_MIGRATIONS_FOLDER)
})

afterEach(async () => {
  for (const resource of databases.splice(0)) {
    await resource.database.close()
    await rm(resource.directory, { force: true, recursive: true })
  }
})

afterAll(async () => {
  await rm(templateDirectory, { force: true, recursive: true })
})

describe("ProjectDatabase", () => {
  it("builds a reusable schema-only template with the complete migration journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heron-project-template-verifier-"))
    const verifier = await PGlite.create({
      dataDir: join(directory, "pgdata"),
      loadDataDir: new Blob([await readFile(templateArchivePath)])
    })
    try {
      const projectRows = await verifier.query<{ count: number }>(
        "select count(*)::int as count from project"
      )
      const migrationRows = await verifier.query<{ count: number }>(
        "select count(*)::int as count from drizzle.__drizzle_migrations"
      )
      const journal = JSON.parse(
        await readFile(join(PROJECT_MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")
      ) as { entries: unknown[] }
      expect(projectRows.rows[0]?.count).toBe(0)
      expect(migrationRows.rows[0]?.count).toBe(journal.entries.length)
    } finally {
      await verifier.close()
      await rm(directory, { force: true, recursive: true })
    }
  })

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
      locator: {
        format: "vst3",
        nativeId: "8CD16A11027ACC7FDF0C1419E86D1024"
      },
      role: "instrument",
      descriptor: {
        source: { kind: "builtin", id: "live.minori.heron.metronome" }
      }
    })
    expect(seeded.tempoMap).toEqual({
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    })
    expect(seeded.keySignatureEvents).toEqual([{ tick: 0, fifths: 0, mode: "major" }])
    expect(seeded.channels.find(({ id }) => id === "audio-1")?.inputMonitoring).toBe(false)
    expect(seeded.projectNotes).toBe("")
    expect(seeded.projectEndTick).toBe(61_440)
    expect(seeded.tracks[0]?.notes).toBe("")

    await database.applyCommand(
      { type: "update-project-notes", notes: "# Recording plan" },
      "output-1-2"
    )
    await database.applyCommand({ type: "update-project-end", endTick: 15_360 }, "output-1-2")
    await database.applyCommand(
      { type: "update-track", trackId: "track:audio-1", patch: { notes: "Use take 3." } },
      "output-1-2"
    )
    await database.applyCommand(
      { type: "update-track", trackId: "track:audio-1", patch: { sortOrder: 2 } },
      "output-1-2"
    )
    const noted = await database.mixerSnapshot()
    expect(noted.projectNotes).toBe("# Recording plan")
    expect(noted.projectEndTick).toBe(15_360)
    expect(noted.tracks[0]).toMatchObject({ notes: "Use take 3.", sortOrder: 2 })

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

  it.skip("does not support the pre-baseline track migration level", async () => {
    const resource = await createDatabase()
    const instrument: MixerChannelState = {
      id: "instrument-migrated",
      kind: "instrument",
      systemRole: null,
      name: "Migrated Instrument",
      color: "#73D6A2",
      sortOrder: 8,
      inputSource: null,
      inputFormat: null,
      gainDb: -3,
      pan: 0.2,
      muted: false,
      soloed: false,
      outputChannelId: "output-1-2",
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [],
      hardwareOutputChannels: []
    }
    await resource.database.applyCommand(
      {
        type: "create-track",
        track: {
          id: "track:instrument-migrated",
          channelId: instrument.id,
          sortOrder: 3
        },
        channel: instrument
      },
      "output-1-2"
    )
    await resource.database.importMidi(
      {
        id: "migrated-source",
        name: "Migrated source",
        contentHash: "migrated-source-hash",
        rawBytes: new Uint8Array([1, 2, 3])
      },
      {
        type: "create-midi-clip",
        clip: {
          id: "migrated-clip",
          sourceId: "migrated-source",
          trackId: "track:instrument-migrated",
          name: "Migrated clip",
          startTick: 960,
          lengthTicks: 1920,
          sourceOffsetTicks: 120,
          sourceLengthTicks: 2040,
          notes: [],
          events: []
        }
      },
      "output-1-2"
    )
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await revertTrackMigration(raw)
    } finally {
      await raw.close()
    }

    const migrated = await ProjectDatabase.open(join(resource.directory, "pgdata"))
    databases.push({ database: migrated, directory: resource.directory })
    const snapshot = await migrated.mixerSnapshot()
    expect(snapshot.tracks).toContainEqual({
      id: "track:instrument-migrated",
      channelId: "instrument-migrated",
      sortOrder: 8
    })
    expect(snapshot.midiClips).toContainEqual(
      expect.objectContaining({
        id: "migrated-clip",
        trackId: "track:instrument-migrated",
        startTick: 960,
        lengthTicks: 1920,
        sourceOffsetTicks: 120
      })
    )
    expect(snapshot.channels).toContainEqual(
      expect.objectContaining({ id: "instrument-migrated", sortOrder: 8, gainDb: -3, pan: 0.2 })
    )
  })

  it("persists input monitoring only for Audio channels", async () => {
    const { database } = await createDatabase()
    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "audio-1",
        patch: { inputMonitoring: true }
      },
      "output-1-2"
    )
    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({ inputMonitoring: true })

    await expect(
      database.applyCommand(
        {
          type: "update-channel",
          channelId: "metronome",
          patch: { inputMonitoring: true }
        },
        "output-1-2"
      )
    ).rejects.toThrow()
  })

  it("round-trips application capture targets before enabling input monitoring", async () => {
    const { database } = await createDatabase()
    const target = {
      platform: "windows" as const,
      executablePath: "C:\\Program Files\\Steam\\steam.exe",
      executableName: "steam.exe",
      includeProcessTree: true
    }

    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "audio-1",
        patch: {
          inputSource: "application",
          inputFormat: "stereo",
          inputChannels: [1, 2],
          applicationCapture: target
        }
      },
      "output-1-2"
    )
    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({ inputSource: "application", applicationCapture: target })

    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "audio-1",
        patch: { inputMonitoring: true }
      },
      "output-1-2"
    )
    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({
      inputSource: "application",
      applicationCapture: target,
      inputMonitoring: true
    })

    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "audio-1",
        patch: {
          inputSource: "hardware",
          inputFormat: "stereo",
          inputChannels: [1, 2]
        }
      },
      "output-1-2"
    )
    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({ inputSource: "hardware", applicationCapture: null })
  })

  it("round-trips a macOS application capture bundle identifier without a schema migration", async () => {
    const { database } = await createDatabase()
    const target = {
      platform: "macos" as const,
      bundleIdentifier: "com.example.player",
      executablePath: "/Applications/Player.app/Contents/MacOS/Player",
      executableName: "Player",
      includeProcessTree: true
    }

    await database.applyCommand(
      {
        type: "update-channel",
        channelId: "audio-1",
        patch: {
          inputSource: "application",
          inputFormat: "stereo",
          inputChannels: [1, 2],
          applicationCapture: target
        }
      },
      "output-1-2"
    )

    expect(
      (await database.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({ inputSource: "application", applicationCapture: target })
  })

  it.skip("does not backfill pre-baseline input monitoring state", async () => {
    const resource = await createDatabase()
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await revertTrackMigration(raw)
      await revertMidiInputMigration(raw)
      await revertAraDocumentStateMigration(raw)
      await revertInputMonitoringMigration(raw)
    } finally {
      await raw.close()
    }

    const migrated = await ProjectDatabase.open(join(resource.directory, "pgdata"))
    databases.push({ database: migrated, directory: resource.directory })
    await migrated.migrate()
    expect(
      (await migrated.mixerSnapshot()).channels.find(({ id }) => id === "audio-1")
    ).toMatchObject({ inputMonitoring: false })
  })

  it("round-trips every plugin audio mode", async () => {
    const { database } = await createDatabase()
    const modes = ["mono", "mono-to-stereo", "stereo", "dual-mono"] as const
    await database.applyCommand(
      {
        type: "batch",
        commands: modes.map((audioMode, slotOrder) => ({
          type: "create-plugin" as const,
          plugin: {
            id: `effect-${audioMode}`,
            channelId: "audio-1",
            role: "insert" as const,
            slotOrder,
            locator: {
              format: "vst3",
              artifactPath: "effect.vst3",
              nativeId: "0123456789ABCDEFFEDCBA9876543210"
            },
            descriptor: {
              source: { kind: "external" as const },
              locator: {
                format: "vst3" as const,
                artifactPath: "effect.vst3",
                nativeId: "0123456789ABCDEFFEDCBA9876543210"
              },
              name: "Effect",
              vendor: "Heron Studio",
              version: "1.0",
              categories: ["Fx"],
              kind: "effect" as const,
              architecture: "x86_64",
              buses: [],
              supportedAudioModes: [...modes],
              hasEditor: true,
              compatibility: "compatible" as const,
              compatibilityReason: null
            },
            audioMode,
            enabled: true,
            sidechainInputs: [],
            state: { version: 1 as const, chunks: [] }
          }
        }))
      },
      "audio-1"
    )

    expect(
      (await database.mixerSnapshot()).plugins
        .filter((plugin) => plugin.channelId === "audio-1")
        .map((plugin) => plugin.audioMode)
    ).toEqual(modes)

    await database.savePluginStates([
      {
        id: "effect-stereo",
        state: {
          version: 1,
          chunks: [
            { key: "component", bytes: new Uint8Array([1, 2]) },
            { key: "controller", bytes: new Uint8Array([3]) },
            { key: "ara-document", bytes: new Uint8Array([4, 5, 6]) }
          ]
        }
      }
    ])
    const stored = (await database.mixerSnapshot()).plugins.find(
      (plugin) => plugin.id === "effect-stereo"
    )
    expect(stored?.state).toEqual({
      version: 1,
      chunks: expect.arrayContaining([
        { key: "component", bytes: new Uint8Array([1, 2]) },
        { key: "controller", bytes: new Uint8Array([3]) },
        { key: "ara-document", bytes: new Uint8Array([4, 5, 6]) }
      ])
    })
    expect(stored?.state?.chunks).toHaveLength(3)
  })

  it.skip("does not migrate legacy bus channels into aux routing", async () => {
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
          inputMonitoring: false,
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
      await revertTrackMigration(raw)
      await revertMidiInputMigration(raw)
      await revertAraDocumentStateMigration(raw)
      await revertInputMonitoringMigration(raw)
      await revertPluginAudioModeMigration(raw)
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
        where created_at in (
          select created_at
          from drizzle.__drizzle_migrations
          order by created_at desc
          limit 2
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
      inputMonitoring: false,
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
    await database.applyCommand(
      {
        type: "create-plugin",
        plugin: {
          id: "sidechain-effect",
          channelId: "audio-1",
          role: "insert",
          slotOrder: 0,
          locator: {
            format: "vst3",
            artifactPath: "sidechain.vst3",
            nativeId: "0123456789ABCDEFFEDCBA9876543210"
          },
          descriptor: {
            source: { kind: "external" },
            locator: {
              format: "vst3",
              artifactPath: "sidechain.vst3",
              nativeId: "0123456789ABCDEFFEDCBA9876543210"
            },
            name: "Side-chain Effect",
            vendor: "Heron Studio",
            version: "1.0",
            categories: ["Fx"],
            kind: "effect",
            architecture: "x86_64",
            buses: [
              {
                portKey: "vst3:audio:input:1",
                direction: "input",
                kind: "aux",
                name: "Side-chain",
                channels: 1,
                defaultActive: false
              }
            ],
            supportedAudioModes: ["stereo"],
            hasEditor: true,
            compatibility: "compatible",
            compatibilityReason: null
          },
          audioMode: "stereo",
          enabled: true,
          sidechainInputs: [{ inputPortKey: "vst3:audio:input:1", sourceChannelId: aux.id }],
          state: { version: 1, chunks: [] }
        }
      },
      "output-1-2"
    )
    expect(
      (await database.mixerSnapshot()).plugins.find(({ id }) => id === "sidechain-effect")
        ?.sidechainInputs
    ).toEqual([{ inputPortKey: "vst3:audio:input:1", sourceChannelId: aux.id }])
    await database.applyCommand({ type: "delete-channel", channelId: aux.id }, "output-1-2")
    expect(
      (await database.mixerSnapshot()).plugins.find(({ id }) => id === "sidechain-effect")
        ?.sidechainInputs
    ).toEqual([])
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
            trackId: "track:metronome",
            name: "Invalid",
            startTick: 0,
            sourceOffsetTicks: 0,
            lengthTicks: 960,
            sourceLengthTicks: 960,
            notes: [],
            events: []
          }
        },
        "output-1-2"
      )
    ).rejects.toThrow()
    expect((await database.mixerSnapshot()).channels).toContainEqual(
      expect.objectContaining({ id: "metronome", systemRole: "metronome" })
    )
  })

  it("creates and removes a blank MIDI source and clip atomically", async () => {
    const { database } = await createDatabase()
    const instrument: MixerChannelState = {
      id: "instrument-blank",
      kind: "instrument",
      systemRole: null,
      name: "Instrument",
      color: "#73D6A2",
      sortOrder: 0,
      inputSource: null,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: "output-1-2",
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [],
      hardwareOutputChannels: []
    }
    const source = {
      id: "blank-source",
      name: "MIDI Clip 1",
      contentHash: "blank:blank-source",
      rawBytes: new Uint8Array()
    }
    const track = {
      id: `track:${instrument.id}`,
      channelId: instrument.id,
      sortOrder: instrument.sortOrder
    }
    const clip = {
      id: "blank-clip",
      sourceId: source.id,
      trackId: track.id,
      name: source.name,
      startTick: 960,
      lengthTicks: 3_840,
      sourceOffsetTicks: 0,
      sourceLengthTicks: 3_840,
      notes: [],
      events: []
    }
    const create: ProjectCommand = {
      type: "batch",
      commands: [
        { type: "create-track", track, channel: instrument },
        { type: "create-midi-source", source },
        { type: "create-midi-clip", clip }
      ]
    }

    await database.applyCommand(create, "output-1-2")
    expect((await database.mixerSnapshot()).midiClips).toContainEqual(clip)
    expect(await database.listAssets()).toContainEqual({
      id: source.id,
      kind: "midi",
      name: source.name,
      contentHash: source.contentHash,
      byteLength: 0
    })
    expect(await database.readMidiSource(source.id)).toEqual(source)

    await database.applyCommand(
      {
        type: "batch",
        commands: [
          { type: "delete-midi-clip", clipId: clip.id },
          { type: "delete-midi-source", source }
        ]
      },
      "output-1-2"
    )
    expect((await database.mixerSnapshot()).midiClips).toEqual([])

    await database.applyCommand(
      {
        type: "batch",
        commands: [
          { type: "create-midi-source", source },
          { type: "create-midi-clip", clip }
        ]
      },
      "output-1-2"
    )
    expect((await database.mixerSnapshot()).midiClips).toContainEqual(clip)
  })

  it("restores non-destructive audio and MIDI clip edits after reopening", async () => {
    const resource = await createDatabase()
    const audioPath = join(resource.directory, "editable-audio.wav")
    await writeFile(audioPath, new Uint8Array())
    await resource.database.importLargeObject(audioPath, {
      id: "editable-audio",
      name: "Editable audio",
      mimeType: "audio/x-bwf",
      contentHash: "editable-audio-hash",
      sampleRate: 96_000,
      channels: 2,
      bitDepth: "float32",
      frameCount: 192_000n,
      bwfTimeReference: 0n
    })

    const audioChannel: MixerChannelState = {
      id: "audio-edit",
      kind: "audio",
      systemRole: null,
      name: "Audio edit",
      color: "#5BC0EB",
      sortOrder: 0,
      inputSource: "hardware",
      inputFormat: "stereo",
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: "output-1-2",
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [1, 2],
      hardwareOutputChannels: []
    }
    const instrumentChannel: MixerChannelState = {
      ...audioChannel,
      id: "instrument-edit",
      kind: "instrument",
      name: "Instrument edit",
      sortOrder: 1,
      inputSource: null,
      inputFormat: null,
      inputChannels: []
    }
    await resource.database.applyCommand(
      {
        type: "batch",
        commands: [
          {
            type: "create-track",
            track: { id: "track:audio-edit", channelId: audioChannel.id, sortOrder: 0 },
            channel: audioChannel
          },
          {
            type: "create-track",
            track: {
              id: "track:instrument-edit",
              channelId: instrumentChannel.id,
              sortOrder: 1
            },
            channel: instrumentChannel
          },
          {
            type: "create-midi-source",
            source: {
              id: "editable-midi-source",
              name: "Editable MIDI",
              contentHash: "blank:editable-midi-source",
              rawBytes: new Uint8Array()
            }
          },
          {
            type: "create-midi-clip",
            clip: {
              id: "editable-midi-clip",
              sourceId: "editable-midi-source",
              trackId: "track:instrument-edit",
              name: "Editable MIDI",
              startTick: 0,
              sourceOffsetTicks: 0,
              lengthTicks: 3_840,
              sourceLengthTicks: 3_840,
              notes: [],
              events: []
            }
          },
          {
            type: "create-audio-clip",
            clip: {
              id: "editable-audio-clip",
              assetId: "editable-audio",
              trackId: "track:audio-edit",
              name: "Editable audio",
              startFrame: 0,
              sourceOffsetFrames: 0,
              lengthFrames: 48_000,
              sourceLengthFrames: 96_000,
              fadeInFrames: 0,
              fadeOutFrames: 0,
              assetSampleRate: 96_000,
              assetChannels: 2
            }
          }
        ]
      },
      "output-1-2"
    )
    await resource.database.applyCommand(
      {
        type: "batch",
        commands: [
          {
            type: "update-audio-clip",
            clipId: "editable-audio-clip",
            patch: {
              sourceOffsetFrames: 12_000,
              lengthFrames: 36_000,
              fadeInFrames: 2_400,
              fadeOutFrames: 4_800
            }
          },
          {
            type: "update-midi-clip-range",
            clipId: "editable-midi-clip",
            patch: {
              startTick: 960,
              sourceOffsetTicks: 480,
              lengthTicks: 2_880,
              sourceLengthTicks: 7_680
            }
          }
        ]
      },
      "output-1-2"
    )

    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)
    const reopened = await ProjectDatabase.open(join(resource.directory, "pgdata"))
    databases.push({ database: reopened, directory: resource.directory })

    const restored = await reopened.mixerSnapshot()
    expect(restored.audioClips).toContainEqual(
      expect.objectContaining({
        id: "editable-audio-clip",
        sourceOffsetFrames: 12_000,
        lengthFrames: 36_000,
        sourceLengthFrames: 96_000,
        fadeInFrames: 2_400,
        fadeOutFrames: 4_800
      })
    )
    expect(restored.midiClips).toContainEqual(
      expect.objectContaining({
        id: "editable-midi-clip",
        startTick: 960,
        sourceOffsetTicks: 480,
        lengthTicks: 2_880,
        sourceLengthTicks: 7_680
      })
    )
  })

  it("round-trips atomic piano-roll note edits at 1/3840-note resolution", async () => {
    const { database } = await createDatabase()
    const instrument = {
      id: "instrument-1",
      kind: "instrument" as const,
      systemRole: null,
      name: "Instrument 1",
      color: "#73D6A2",
      sortOrder: 0,
      inputSource: null,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: "output-1-2",
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [],
      hardwareOutputChannels: []
    }
    const clip = {
      id: "midi-clip-1",
      sourceId: "midi-source-1",
      trackId: `track:${instrument.id}`,
      name: "Editable",
      startTick: 960,
      sourceOffsetTicks: 0,
      lengthTicks: 960,
      sourceLengthTicks: 960,
      notes: [
        {
          id: "note-1",
          startTick: 120,
          durationTicks: 240,
          channel: 0,
          key: 60,
          velocity: 100,
          releaseVelocity: 0
        }
      ],
      events: [
        {
          id: "event-1",
          tick: 240,
          channel: 0,
          kind: "control-change" as const,
          data: new Uint8Array([1, 2])
        }
      ]
    }
    await database.importMidi(
      {
        id: clip.sourceId,
        name: "editable.mid",
        contentHash: "editable-midi-source",
        rawBytes: new Uint8Array([0x4d, 0x54, 0x68, 0x64])
      },
      {
        type: "batch",
        commands: [
          {
            type: "create-track",
            track: {
              id: `track:${instrument.id}`,
              channelId: instrument.id,
              sortOrder: instrument.sortOrder
            },
            channel: instrument
          },
          { type: "create-midi-clip", clip }
        ]
      },
      "output-1-2"
    )

    await database.applyCommand(
      {
        type: "batch",
        commands: [
          {
            type: "rebase-midi-clip-content",
            clipId: clip.id,
            deltaTicks: 240
          },
          {
            type: "update-midi-clip-range",
            clipId: clip.id,
            patch: { startTick: 720, lengthTicks: 1_200, sourceLengthTicks: 1_200 }
          },
          {
            type: "update-midi-notes",
            clipId: clip.id,
            updates: [
              {
                noteId: "note-1",
                patch: { startTick: 1, durationTicks: 1, velocity: 127 }
              }
            ]
          },
          {
            type: "create-midi-notes",
            clipId: clip.id,
            notes: [
              {
                id: "note-2",
                startTick: 480,
                durationTicks: 1,
                channel: 15,
                key: 127,
                velocity: 1,
                releaseVelocity: 127
              }
            ]
          }
        ]
      },
      "output-1-2"
    )

    const edited = (await database.mixerSnapshot()).midiClips[0]!
    expect(edited).toMatchObject({ startTick: 720, lengthTicks: 1_200 })
    expect(edited.notes).toEqual([
      expect.objectContaining({ id: "note-1", startTick: 1, durationTicks: 1, velocity: 127 }),
      expect.objectContaining({ id: "note-2", durationTicks: 1, channel: 15, key: 127 })
    ])
    expect(edited.events[0]?.tick).toBe(480)

    await expect(
      database.applyCommand(
        {
          type: "batch",
          commands: [
            {
              type: "create-midi-notes",
              clipId: clip.id,
              notes: [
                {
                  id: "rolled-back-note",
                  startTick: 0,
                  durationTicks: 1,
                  channel: 0,
                  key: 60,
                  velocity: 100,
                  releaseVelocity: 0
                }
              ]
            },
            {
              type: "update-midi-notes",
              clipId: clip.id,
              updates: [{ noteId: "note-2", patch: { durationTicks: 0 } }]
            }
          ]
        },
        "output-1-2"
      )
    ).rejects.toThrow()
    expect((await database.mixerSnapshot()).midiClips[0]?.notes).not.toContainEqual(
      expect.objectContaining({ id: "rolled-back-note" })
    )
  })

  it.skip("does not seed metronome state into pre-baseline projects", async () => {
    const resource = await createDatabase()
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await revertTrackMigration(raw)
      await revertMidiInputMigration(raw)
      await revertAraDocumentStateMigration(raw)
      await revertInputMonitoringMigration(raw)
      await revertPluginAudioModeMigration(raw)
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
          limit 6
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
        locator: expect.objectContaining({
          format: "vst3",
          nativeId: "8CD16A11027ACC7FDF0C1419E86D1024"
        }),
        audioMode: "stereo"
      })
    ])
    expect(snapshot.keySignatureEvents).toEqual([{ tick: 0, fifths: 0, mode: "major" }])
  })

  it.skip("does not convert pre-baseline pitch-class key events", async () => {
    const resource = await createDatabase()
    await resource.database.close()
    databases.splice(databases.indexOf(resource), 1)

    const raw = new PGlite(join(resource.directory, "pgdata"))
    try {
      await revertTrackMigration(raw)
      await revertMidiInputMigration(raw)
      await revertAraDocumentStateMigration(raw)
      await revertInputMonitoringMigration(raw)
      await revertPluginAudioModeMigration(raw)
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
          limit 4
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
        kind: "audio",
        name: "Audio",
        contentHash: "hash-1",
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
    const restoredDirectory = await mkdtemp(join(tmpdir(), "heron-project-db-restored-"))
    const restored = await ProjectDatabase.open(join(restoredDirectory, "pgdata"), archivePath)
    databases.push({ database: restored, directory: restoredDirectory })

    expect(await restored.readLargeObject("asset-1")).toEqual(audio)
    expect(await restored.readWaveform("asset-1", 0, 2, 100)).toMatchObject({
      startFrame: 0,
      endFrame: 2,
      framesPerBucket: 2,
      bucketCount: 1,
      peaks: encodePeaks([-1, 1, -0.5, 0.5])
    })
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

  it("selects and slices one waveform level inside PGlite", async () => {
    const { database, directory } = await createDatabase()
    const audioPath = join(directory, "waveform-window.bwf")
    await writeFile(audioPath, new Uint8Array())
    const detailedValues = Array.from({ length: 24 }, (_, index) => index + 1)
    const overviewValues = Array.from({ length: 12 }, (_, index) => 101 + index)
    await database.importLargeObject(audioPath, {
      id: "waveform-window",
      name: "Waveform window",
      mimeType: "audio/x-bwf",
      contentHash: "waveform-window-hash",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32",
      frameCount: 12n,
      bwfTimeReference: 0n,
      waveformLevels: [
        {
          framesPerBucket: 2,
          bucketCount: 6,
          peaks: encodePeaks(detailedValues)
        },
        {
          framesPerBucket: 4,
          bucketCount: 3,
          peaks: encodePeaks(overviewValues)
        }
      ]
    })

    expect(await database.readWaveform("waveform-window", 3, 9, 100)).toEqual({
      sampleRate: 48_000,
      channels: 2,
      frameCount: 12,
      startFrame: 2,
      endFrame: 10,
      framesPerBucket: 2,
      bucketCount: 4,
      peaks: encodePeaks(detailedValues.slice(4, 20))
    })
    expect(await database.readWaveform("waveform-window", 0, 12, 3)).toEqual({
      sampleRate: 48_000,
      channels: 2,
      frameCount: 12,
      startFrame: 0,
      endFrame: 12,
      framesPerBucket: 4,
      bucketCount: 3,
      peaks: encodePeaks(overviewValues)
    })
    expect(await database.readWaveform("waveform-window", -10, 30, 100)).toEqual({
      sampleRate: 48_000,
      channels: 2,
      frameCount: 12,
      startFrame: 0,
      endFrame: 12,
      framesPerBucket: 2,
      bucketCount: 6,
      peaks: encodePeaks(detailedValues)
    })
    expect(await database.readWaveform("waveform-window", 10, 2, 100)).toMatchObject({
      startFrame: 10,
      endFrame: 10,
      bucketCount: 0,
      peaks: new Uint8Array()
    })
    expect(await database.readWaveform("missing", 0, 10, 100)).toBeNull()
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

    const verificationDirectory = await mkdtemp(join(tmpdir(), "heron-maintained-archive-"))
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

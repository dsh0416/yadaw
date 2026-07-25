import { createHash } from "node:crypto"

export interface ProjectMigration {
  id: string
  hash: string
  sql: readonly string[]
}

const initialSql = [
  `CREATE TABLE project (
    id text PRIMARY KEY,
    name text NOT NULL,
    sample_rate integer NOT NULL CHECK (sample_rate IN (44100, 48000, 88200, 96000, 176400, 192000)),
    tempo double precision NOT NULL CHECK (tempo > 0),
    time_signature_numerator smallint NOT NULL CHECK (time_signature_numerator BETWEEN 1 AND 32),
    time_signature_denominator smallint NOT NULL CHECK (time_signature_denominator IN (1, 2, 4, 8, 16, 32))
  )`,
  `CREATE TABLE assets (
    id text PRIMARY KEY,
    name text NOT NULL,
    mime_type text NOT NULL CHECK (mime_type = 'audio/x-bwf'),
    content_hash text NOT NULL UNIQUE,
    byte_length bigint NOT NULL CHECK (byte_length >= 0),
    sample_rate integer NOT NULL CHECK (sample_rate > 0),
    channels smallint NOT NULL CHECK (channels > 0),
    bit_depth text NOT NULL CHECK (bit_depth IN ('float32', 'pcm24', 'pcm16')),
    frame_count bigint NOT NULL CHECK (frame_count >= 0),
    bwf_time_reference bigint NOT NULL CHECK (bwf_time_reference >= 0),
    large_object_oid oid NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE FUNCTION yadaw_unlink_asset_large_object() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM lo_unlink(OLD.large_object_oid);
      RETURN OLD;
    END
    $$`,
  `CREATE TRIGGER assets_unlink_large_object
    AFTER DELETE ON assets
    FOR EACH ROW EXECUTE FUNCTION yadaw_unlink_asset_large_object()`
] as const

const waveformCacheSql = [
  `ALTER TABLE project
   ADD COLUMN waveform_display_mode text NOT NULL DEFAULT 'separate'
   CHECK (waveform_display_mode IN ('separate', 'aggregate'))`,
  `CREATE TABLE asset_waveform_levels (
    asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    cache_version smallint NOT NULL,
    level smallint NOT NULL,
    frames_per_bucket integer NOT NULL CHECK (frames_per_bucket > 0),
    bucket_count integer NOT NULL CHECK (bucket_count >= 0),
    channels smallint NOT NULL CHECK (channels > 0),
    sample_rate integer NOT NULL CHECK (sample_rate > 0),
    frame_count bigint NOT NULL CHECK (frame_count >= 0),
    peaks bytea NOT NULL,
    PRIMARY KEY (asset_id, cache_version, level),
    CHECK (octet_length(peaks) = bucket_count * channels * 8)
  )`
] as const

const mixerGraphSql = [
  `CREATE TABLE mixer_channels (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('audio', 'bus', 'master')),
    name text NOT NULL CHECK (length(trim(name)) > 0),
    color text NOT NULL CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    channel_format text NOT NULL CHECK (channel_format IN ('mono', 'stereo')),
    gain_db double precision NOT NULL DEFAULT 0 CHECK (gain_db BETWEEN -90 AND 12),
    pan double precision NOT NULL DEFAULT 0 CHECK (pan BETWEEN -1 AND 1),
    muted boolean NOT NULL DEFAULT false,
    soloed boolean NOT NULL DEFAULT false,
    output_channel_id text REFERENCES mixer_channels(id) ON DELETE RESTRICT,
    record_armed boolean NOT NULL DEFAULT false,
    input_channels smallint[] NOT NULL DEFAULT ARRAY[1, 2]::smallint[],
    CHECK (kind = 'audio' OR channel_format = 'stereo'),
    CHECK ((kind = 'master') = (output_channel_id IS NULL)),
    CHECK (
      (kind = 'audio' AND (
        (channel_format = 'mono' AND cardinality(input_channels) = 1) OR
        (channel_format = 'stereo' AND cardinality(input_channels) = 2)
      )) OR
      (kind <> 'audio' AND cardinality(input_channels) = 0)
    ),
    CHECK (0 < ALL(input_channels))
  )`,
  `CREATE UNIQUE INDEX mixer_master_singleton
    ON mixer_channels ((kind)) WHERE kind = 'master'`,
  `CREATE INDEX mixer_channel_sort_order
    ON mixer_channels (kind, sort_order)`,
  `INSERT INTO mixer_channels (
    id, kind, name, color, sort_order, channel_format, gain_db, pan,
    muted, soloed, output_channel_id, record_armed, input_channels
  ) VALUES (
    'master', 'master', 'Master', '#67D9E7', 0, 'stereo', 0, 0,
    false, false, NULL, false, ARRAY[]::smallint[]
  )`,
  `INSERT INTO mixer_channels (
    id, kind, name, color, sort_order, channel_format, gain_db, pan,
    muted, soloed, output_channel_id, record_armed, input_channels
  ) VALUES (
    'audio-1', 'audio', 'Audio 1', '#8C83FF', 0, 'stereo', 0, 0,
    false, false, 'master', false, ARRAY[1, 2]::smallint[]
  )`,
  `CREATE TABLE timeline_clips (
    id text PRIMARY KEY,
    asset_id text NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    track_id text NOT NULL REFERENCES mixer_channels(id) ON DELETE CASCADE,
    name text NOT NULL CHECK (length(trim(name)) > 0),
    start_frame bigint NOT NULL CHECK (start_frame >= 0),
    source_offset_frames bigint NOT NULL DEFAULT 0 CHECK (source_offset_frames >= 0),
    length_frames bigint NOT NULL CHECK (length_frames > 0)
  )`,
  `CREATE INDEX timeline_clips_track_start
    ON timeline_clips (track_id, start_frame)`,
  `INSERT INTO timeline_clips (
    id, asset_id, track_id, name, start_frame, source_offset_frames, length_frames
  )
  SELECT
    'clip-' || a.id,
    a.id,
    'audio-1',
    regexp_replace(a.name, '\\.bwf$', '', 'i'),
    COALESCE(
      sum(round(frame_count::numeric * p.sample_rate / a.sample_rate))
        OVER (ORDER BY created_at, a.id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),
      0
    )::bigint,
    0,
    GREATEST(1, round(frame_count::numeric * p.sample_rate / a.sample_rate))::bigint
  FROM assets a CROSS JOIN project p`,
  `CREATE TABLE mixer_sends (
    id text PRIMARY KEY,
    source_channel_id text NOT NULL REFERENCES mixer_channels(id) ON DELETE CASCADE,
    target_channel_id text NOT NULL REFERENCES mixer_channels(id) ON DELETE CASCADE,
    sort_order integer NOT NULL CHECK (sort_order >= 0),
    enabled boolean NOT NULL DEFAULT false,
    tap text NOT NULL DEFAULT 'post' CHECK (tap IN ('pre', 'post')),
    level_db double precision NOT NULL DEFAULT -90 CHECK (level_db BETWEEN -90 AND 12),
    pan double precision NOT NULL DEFAULT 0 CHECK (pan BETWEEN -1 AND 1),
    UNIQUE (source_channel_id, target_channel_id),
    CHECK (source_channel_id <> target_channel_id)
  )`,
  `CREATE INDEX mixer_sends_source_order
    ON mixer_sends (source_channel_id, sort_order)`
] as const

const outputRoutingSql = [
  `ALTER TABLE mixer_channels RENAME COLUMN channel_format TO input_format`,
  `ALTER TABLE mixer_channels ALTER COLUMN input_format DROP NOT NULL`,
  `ALTER TABLE mixer_channels
    ADD COLUMN hardware_output_channels smallint[] NOT NULL DEFAULT ARRAY[]::smallint[]`,
  `DO $$
    DECLARE constraint_name text;
    BEGIN
      FOR constraint_name IN
        SELECT conname
        FROM pg_constraint
        WHERE conrelid = 'mixer_channels'::regclass AND contype = 'c'
      LOOP
        EXECUTE format('ALTER TABLE mixer_channels DROP CONSTRAINT %I', constraint_name);
      END LOOP;
    END
    $$`,
  `UPDATE mixer_channels SET input_format = NULL WHERE kind <> 'audio'`,
  `INSERT INTO mixer_channels (
    id, kind, name, color, sort_order, input_format, gain_db, pan,
    muted, soloed, output_channel_id, record_armed, input_channels,
    hardware_output_channels
  ) VALUES (
    'output-1-2', 'output', 'Output 1–2', '#73D6A2', 0, NULL, 0, 0,
    false, false, NULL, false, ARRAY[]::smallint[], ARRAY[1, 2]::smallint[]
  )`,
  `UPDATE mixer_channels
    SET output_channel_id = 'output-1-2'
    WHERE output_channel_id = 'master'`,
  `ALTER TABLE mixer_channels
    ADD CONSTRAINT mixer_channels_kind_check
      CHECK (kind IN ('audio', 'bus', 'master', 'output')),
    ADD CONSTRAINT mixer_channels_name_check
      CHECK (length(trim(name)) > 0),
    ADD CONSTRAINT mixer_channels_color_check
      CHECK (color ~ '^#[0-9A-Fa-f]{6}$'),
    ADD CONSTRAINT mixer_channels_sort_order_check
      CHECK (sort_order >= 0),
    ADD CONSTRAINT mixer_channels_gain_db_check
      CHECK (gain_db BETWEEN -90 AND 12),
    ADD CONSTRAINT mixer_channels_pan_check
      CHECK (pan BETWEEN -1 AND 1),
    ADD CONSTRAINT mixer_channels_master_solo_check
      CHECK (kind <> 'master' OR NOT soloed),
    ADD CONSTRAINT mixer_channels_output_route_check
      CHECK ((kind IN ('master', 'output')) = (output_channel_id IS NULL)),
    ADD CONSTRAINT mixer_channels_input_check
      CHECK (
        (kind = 'audio' AND input_format IS NOT NULL AND (
          (input_format = 'mono' AND cardinality(input_channels) = 1) OR
          (input_format = 'stereo' AND cardinality(input_channels) = 2)
        )) OR
        (kind <> 'audio' AND input_format IS NULL
          AND cardinality(input_channels) = 0 AND NOT record_armed)
      ),
    ADD CONSTRAINT mixer_channels_input_channels_check
      CHECK (0 < ALL(input_channels)),
    ADD CONSTRAINT mixer_channels_hardware_output_check
      CHECK (
        (kind = 'output'
          AND cardinality(hardware_output_channels) = 2
          AND hardware_output_channels[1] <> hardware_output_channels[2]
          AND 0 < ALL(hardware_output_channels)) OR
        (kind <> 'output' AND cardinality(hardware_output_channels) = 0)
      )`,
  `CREATE UNIQUE INDEX mixer_output_channels_unique
    ON mixer_channels (hardware_output_channels) WHERE kind = 'output'`
] as const

const channelTypeColorsSql = [
  `UPDATE mixer_channels
    SET color = '#4F8CFF'
    WHERE id = 'audio-1' AND kind = 'audio' AND color = '#8C83FF'`,
  `UPDATE mixer_channels
    SET color = '#8C83FF'
    WHERE id = 'master' AND kind = 'master' AND color = '#67D9E7'`,
  `UPDATE mixer_channels
    SET color = '#EF7C95'
    WHERE id = 'output-1-2' AND kind = 'output' AND color = '#73D6A2'`
] as const

function hashStatements(statements: readonly string[]): string {
  return createHash("sha256").update(statements.join("\n-- statement boundary --\n")).digest("hex")
}

export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [
  { id: "0000_initial", hash: hashStatements(initialSql), sql: initialSql },
  { id: "0001_waveform_cache", hash: hashStatements(waveformCacheSql), sql: waveformCacheSql },
  { id: "0002_mixer_graph", hash: hashStatements(mixerGraphSql), sql: mixerGraphSql },
  {
    id: "0003_output_routing",
    hash: hashStatements(outputRoutingSql),
    sql: outputRoutingSql
  },
  {
    id: "0004_channel_type_colors",
    hash: hashStatements(channelTypeColorsSql),
    sql: channelTypeColorsSql
  }
]

export const MIGRATION_JOURNAL_TABLE = "__drizzle_migrations"

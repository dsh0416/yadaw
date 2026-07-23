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

function hashStatements(statements: readonly string[]): string {
  return createHash("sha256").update(statements.join("\n-- statement boundary --\n")).digest("hex")
}

export const PROJECT_MIGRATIONS: readonly ProjectMigration[] = [
  { id: "0000_initial", hash: hashStatements(initialSql), sql: initialSql }
]

export const MIGRATION_JOURNAL_TABLE = "__drizzle_migrations"

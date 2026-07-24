import { customType, doublePrecision, integer, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core"

export const PROJECT_SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000] as const
export type ProjectSampleRate = (typeof PROJECT_SAMPLE_RATES)[number]

export const PROJECT_ID = "project"

export const pgOid = customType<{ data: number; driverData: number }>({
  dataType() {
    return "oid"
  },
  fromDriver(value) {
    return Number(value)
  },
  toDriver(value) {
    return value
  }
})

export const project = pgTable("project", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  tempo: doublePrecision("tempo").notNull(),
  timeSignatureNumerator: smallint("time_signature_numerator").notNull(),
  timeSignatureDenominator: smallint("time_signature_denominator").notNull(),
  waveformDisplayMode: text("waveform_display_mode").notNull()
})

export const assets = pgTable("assets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull(),
  contentHash: text("content_hash").notNull().unique(),
  byteLength: customType<{ data: bigint; driverData: string }>({
    dataType: () => "bigint",
    fromDriver: (value) => BigInt(value),
    toDriver: (value) => value.toString()
  })("byte_length").notNull(),
  sampleRate: integer("sample_rate").notNull(),
  channels: smallint("channels").notNull(),
  bitDepth: text("bit_depth").notNull(),
  frameCount: customType<{ data: bigint; driverData: string }>({
    dataType: () => "bigint",
    fromDriver: (value) => BigInt(value),
    toDriver: (value) => value.toString()
  })("frame_count").notNull(),
  bwfTimeReference: customType<{ data: bigint; driverData: string }>({
    dataType: () => "bigint",
    fromDriver: (value) => BigInt(value),
    toDriver: (value) => value.toString()
  })("bwf_time_reference").notNull(),
  largeObjectOid: pgOid("large_object_oid").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow()
})

export type Project = typeof project.$inferSelect
export type Asset = typeof assets.$inferSelect

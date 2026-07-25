import { boolean, customType, doublePrecision, integer, pgTable, smallint, text, timestamp } from "drizzle-orm/pg-core"

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

export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea"
})

export const int8Number = customType<{ data: number; driverData: string }>({
  dataType: () => "bigint",
  fromDriver: (value) => Number(value),
  toDriver: (value) => String(value)
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

export const mixerChannels = pgTable("mixer_channels", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"audio" | "instrument" | "bus" | "master" | "output">().notNull(),
  name: text("name").notNull(),
  color: text("color").notNull(),
  sortOrder: integer("sort_order").notNull(),
  inputFormat: text("input_format").$type<"mono" | "stereo">(),
  gainDb: doublePrecision("gain_db").notNull(),
  pan: doublePrecision("pan").notNull(),
  muted: boolean("muted").notNull(),
  soloed: boolean("soloed").notNull(),
  outputChannelId: text("output_channel_id"),
  recordArmed: boolean("record_armed").notNull(),
  inputChannels: smallint("input_channels").array().$type<number[]>().notNull(),
  hardwareOutputChannels: smallint("hardware_output_channels").array().$type<number[]>().notNull()
})

export const timelineClips = pgTable("timeline_clips", {
  id: text("id").primaryKey(),
  assetId: text("asset_id").notNull(),
  trackId: text("track_id").notNull(),
  name: text("name").notNull(),
  startFrame: customType<{ data: bigint; driverData: string }>({
    dataType: () => "bigint",
    fromDriver: (value) => BigInt(value),
    toDriver: (value) => value.toString()
  })("start_frame").notNull(),
  sourceOffsetFrames: customType<{ data: bigint; driverData: string }>({
    dataType: () => "bigint",
    fromDriver: (value) => BigInt(value),
    toDriver: (value) => value.toString()
  })("source_offset_frames").notNull(),
  lengthFrames: customType<{ data: bigint; driverData: string }>({
    dataType: () => "bigint",
    fromDriver: (value) => BigInt(value),
    toDriver: (value) => value.toString()
  })("length_frames").notNull()
})

export const mixerSends = pgTable("mixer_sends", {
  id: text("id").primaryKey(),
  sourceChannelId: text("source_channel_id").notNull(),
  targetChannelId: text("target_channel_id").notNull(),
  sortOrder: integer("sort_order").notNull(),
  enabled: boolean("enabled").notNull(),
  tap: text("tap").$type<"pre" | "post">().notNull(),
  levelDb: doublePrecision("level_db").notNull(),
  pan: doublePrecision("pan").notNull()
})

export const pluginInstances = pgTable("plugin_instances", {
  id: text("id").primaryKey(),
  channelId: text("channel_id").notNull(),
  role: text("role").$type<"instrument" | "insert">().notNull(),
  slotOrder: integer("slot_order").notNull(),
  classId: text("class_id").notNull(),
  descriptorSnapshot: text("descriptor_snapshot").notNull(),
  enabled: boolean("enabled").notNull(),
  componentState: bytea("component_state").notNull(),
  controllerState: bytea("controller_state").notNull()
})

export const tempoEvents = pgTable("tempo_events", {
  tick: int8Number("tick").primaryKey(),
  beatsPerMinute: doublePrecision("beats_per_minute").notNull()
})

export const timeSignatureEvents = pgTable("time_signature_events", {
  tick: int8Number("tick").primaryKey(),
  numerator: smallint("numerator").notNull(),
  denominator: smallint("denominator").notNull()
})

export const midiSources = pgTable("midi_sources", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  contentHash: text("content_hash").notNull().unique(),
  rawBytes: bytea("raw_bytes").notNull()
})

export const midiClips = pgTable("midi_clips", {
  id: text("id").primaryKey(),
  sourceId: text("source_id").notNull(),
  trackId: text("track_id").notNull(),
  name: text("name").notNull(),
  startTick: int8Number("start_tick").notNull(),
  lengthTicks: int8Number("length_ticks").notNull(),
  sourceOffsetTicks: int8Number("source_offset_ticks").notNull()
})

export const midiNotes = pgTable("midi_notes", {
  id: text("id").primaryKey(),
  clipId: text("clip_id").notNull(),
  startTick: int8Number("start_tick").notNull(),
  durationTicks: int8Number("duration_ticks").notNull(),
  channel: smallint("channel").notNull(),
  key: smallint("key").notNull(),
  velocity: smallint("velocity").notNull(),
  releaseVelocity: smallint("release_velocity").notNull()
})

export const midiEvents = pgTable("midi_events", {
  id: text("id").primaryKey(),
  clipId: text("clip_id").notNull(),
  tick: int8Number("tick").notNull(),
  channel: smallint("channel"),
  kind: text("kind").$type<
    "control-change" | "pitch-bend" | "program-change" |
    "channel-pressure" | "poly-pressure" | "sysex"
  >().notNull(),
  data: bytea("data").notNull()
})

export type Project = typeof project.$inferSelect
export type Asset = typeof assets.$inferSelect
export type MixerChannel = typeof mixerChannels.$inferSelect
export type TimelineClip = typeof timelineClips.$inferSelect
export type MixerSend = typeof mixerSends.$inferSelect
export type PluginInstance = typeof pluginInstances.$inferSelect
export type TempoEvent = typeof tempoEvents.$inferSelect
export type TimeSignatureEvent = typeof timeSignatureEvents.$inferSelect
export type MidiSource = typeof midiSources.$inferSelect
export type MidiClip = typeof midiClips.$inferSelect
export type MidiNote = typeof midiNotes.$inferSelect
export type MidiEvent = typeof midiEvents.$inferSelect

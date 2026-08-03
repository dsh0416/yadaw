import { relations, sql } from "drizzle-orm"
import type { PluginAudioMode } from "@heron/contracts"
import {
  boolean,
  check,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex
} from "drizzle-orm/pg-core"

export const PROJECT_SAMPLE_RATES = [44_100, 48_000, 88_200, 96_000, 176_400, 192_000] as const
export type ProjectSampleRate = (typeof PROJECT_SAMPLE_RATES)[number]

export const PROJECT_ID = "project"
export const WAVEFORM_CACHE_VERSION = 1

export const pgOid = customType<{ data: number; driverData: number }>({
  dataType: () => "oid",
  fromDriver: Number,
  toDriver: (value) => value
})

export const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea"
})

export const int8Number = customType<{ data: number; driverData: string }>({
  dataType: () => "bigint",
  fromDriver: Number,
  toDriver: String
})

export const int8BigInt = customType<{ data: bigint; driverData: string }>({
  dataType: () => "bigint",
  fromDriver: BigInt,
  toDriver: String
})

export const project = pgTable(
  "project",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    waveformDisplayMode: text("waveform_display_mode").$type<"separate" | "aggregate">().notNull(),
    notes: text("notes").notNull().default("")
  },
  (table) => [
    check("project_singleton_id_check", sql`${table.id} = 'project'`),
    check("project_name_check", sql`length(trim(${table.name})) > 0`),
    check(
      "project_sample_rate_check",
      sql`${table.sampleRate} in (44100, 48000, 88200, 96000, 176400, 192000)`
    ),
    check(
      "project_waveform_display_mode_check",
      sql`${table.waveformDisplayMode} in ('separate', 'aggregate')`
    )
  ]
)

export const assets = pgTable(
  "assets",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    mimeType: text("mime_type").$type<"audio/x-bwf">().notNull(),
    contentHash: text("content_hash").notNull(),
    byteLength: int8BigInt("byte_length").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    channels: smallint("channels").notNull(),
    bitDepth: text("bit_depth").$type<"float32" | "pcm24" | "pcm16">().notNull(),
    frameCount: int8BigInt("frame_count").notNull(),
    bwfTimeReference: int8BigInt("bwf_time_reference").notNull(),
    largeObjectOid: pgOid("large_object_oid").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("assets_content_hash_unique").on(table.contentHash),
    uniqueIndex("assets_large_object_oid_unique").on(table.largeObjectOid),
    index("assets_created_at_index").on(table.createdAt, table.id),
    check("assets_name_check", sql`length(trim(${table.name})) > 0`),
    check("assets_mime_type_check", sql`${table.mimeType} = 'audio/x-bwf'`),
    check("assets_byte_length_check", sql`${table.byteLength} >= 0`),
    check("assets_sample_rate_check", sql`${table.sampleRate} > 0`),
    check("assets_channels_check", sql`${table.channels} > 0`),
    check("assets_bit_depth_check", sql`${table.bitDepth} in ('float32', 'pcm24', 'pcm16')`),
    check("assets_frame_count_check", sql`${table.frameCount} >= 0`),
    check("assets_bwf_time_reference_check", sql`${table.bwfTimeReference} >= 0`)
  ]
)

export const assetWaveformLevels = pgTable(
  "asset_waveform_levels",
  {
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    cacheVersion: smallint("cache_version").notNull(),
    level: smallint("level").notNull(),
    framesPerBucket: integer("frames_per_bucket").notNull(),
    bucketCount: integer("bucket_count").notNull(),
    channels: smallint("channels").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    frameCount: int8BigInt("frame_count").notNull(),
    peaks: bytea("peaks").notNull()
  },
  (table) => [
    primaryKey({ columns: [table.assetId, table.cacheVersion, table.level] }),
    check("asset_waveform_levels_cache_version_check", sql`${table.cacheVersion} > 0`),
    check("asset_waveform_levels_level_check", sql`${table.level} >= 0`),
    check("asset_waveform_levels_frames_per_bucket_check", sql`${table.framesPerBucket} > 0`),
    check("asset_waveform_levels_bucket_count_check", sql`${table.bucketCount} >= 0`),
    check("asset_waveform_levels_channels_check", sql`${table.channels} > 0`),
    check("asset_waveform_levels_sample_rate_check", sql`${table.sampleRate} > 0`),
    check("asset_waveform_levels_frame_count_check", sql`${table.frameCount} >= 0`),
    check(
      "asset_waveform_levels_peaks_length_check",
      sql`octet_length(${table.peaks}) = ${table.bucketCount} * ${table.channels} * 8`
    )
  ]
)

export const mixerChannels = pgTable(
  "mixer_channels",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<"audio" | "instrument" | "aux" | "master" | "output">().notNull(),
    systemRole: text("system_role").$type<"metronome">(),
    name: text("name").notNull(),
    color: text("color").notNull(),
    sortOrder: integer("sort_order").notNull(),
    inputSource: text("input_source").$type<"hardware" | "bus">(),
    inputFormat: text("input_format").$type<"mono" | "stereo">(),
    midiInputPortId: text("midi_input_port_id"),
    midiInputPortName: text("midi_input_port_name"),
    midiInputChannel: smallint("midi_input_channel"),
    gainDb: doublePrecision("gain_db").notNull().default(0),
    pan: doublePrecision("pan").notNull().default(0),
    muted: boolean("muted").notNull().default(false),
    soloed: boolean("soloed").notNull().default(false),
    outputChannelId: text("output_channel_id"),
    outputBus: smallint("output_bus"),
    recordArmed: boolean("record_armed").notNull().default(false),
    inputMonitoring: boolean("input_monitoring").notNull().default(false),
    inputChannels: smallint("input_channels")
      .array()
      .$type<number[]>()
      .notNull()
      .default(sql`array[]::smallint[]`),
    hardwareOutputChannels: smallint("hardware_output_channels")
      .array()
      .$type<number[]>()
      .notNull()
      .default(sql`array[]::smallint[]`)
  },
  (table) => [
    foreignKey({
      columns: [table.outputChannelId],
      foreignColumns: [table.id],
      name: "mixer_channels_output_channel_id_fk"
    }).onDelete("restrict"),
    uniqueIndex("mixer_master_singleton")
      .on(table.kind)
      .where(sql`${table.kind} = 'master'`),
    uniqueIndex("mixer_output_channels_unique")
      .on(table.hardwareOutputChannels)
      .where(sql`${table.kind} = 'output'`),
    uniqueIndex("mixer_system_role_singleton")
      .on(table.systemRole)
      .where(sql`${table.systemRole} is not null`),
    index("mixer_channel_sort_order").on(table.kind, table.sortOrder),
    check(
      "mixer_channels_kind_check",
      sql`${table.kind} in ('audio', 'instrument', 'aux', 'master', 'output')`
    ),
    check(
      "mixer_channels_system_role_check",
      sql`${table.systemRole} is null or ${table.systemRole} = 'metronome'`
    ),
    check(
      "mixer_channels_system_role_kind_check",
      sql`${table.systemRole} is null or ${table.kind} = 'instrument'`
    ),
    check("mixer_channels_name_check", sql`length(trim(${table.name})) > 0`),
    check("mixer_channels_color_check", sql`${table.color} ~ '^#[0-9A-Fa-f]{6}$'`),
    check("mixer_channels_sort_order_check", sql`${table.sortOrder} >= 0`),
    check("mixer_channels_gain_db_check", sql`${table.gainDb} between -90 and 12`),
    check("mixer_channels_pan_check", sql`${table.pan} between -1 and 1`),
    check(
      "mixer_channels_master_solo_check",
      sql`${table.kind} <> 'master' or not ${table.soloed}`
    ),
    check(
      "mixer_channels_input_monitoring_check",
      sql`(${table.kind} = 'audio' or (${table.kind} = 'instrument' and ${table.systemRole} is null))
        or not ${table.inputMonitoring}`
    ),
    check(
      "mixer_channels_record_armed_check",
      sql`(${table.kind} = 'audio' or (${table.kind} = 'instrument' and ${table.systemRole} is null))
        or not ${table.recordArmed}`
    ),
    check(
      "mixer_channels_midi_input_check",
      sql`(
        ${table.kind} = 'instrument'
        and ${table.systemRole} is null
        and (
          (${table.midiInputPortId} is null and ${table.midiInputPortName} is null)
          or (${table.midiInputPortId} is not null and ${table.midiInputPortName} is not null)
        )
        and (${table.midiInputChannel} is null or ${table.midiInputChannel} between 0 and 15)
      ) or (
        not (${table.kind} = 'instrument' and ${table.systemRole} is null)
        and ${table.midiInputPortId} is null
        and ${table.midiInputPortName} is null
        and ${table.midiInputChannel} is null
      )`
    ),
    check(
      "mixer_channels_output_route_check",
      sql`(
        ${table.kind} in ('master', 'output')
        and ${table.outputChannelId} is null
        and ${table.outputBus} is null
      ) or (
        ${table.kind} not in ('master', 'output')
        and num_nonnulls(${table.outputChannelId}, ${table.outputBus}) = 1
      )`
    ),
    check(
      "mixer_channels_output_bus_check",
      sql`${table.outputBus} is null or ${table.outputBus} between 1 and 256`
    ),
    check(
      "mixer_channels_input_check",
      sql`(
      ${table.kind} in ('audio', 'aux')
      and ${table.inputSource} is not null
      and ${table.inputFormat} is not null
      and (
        (${table.inputFormat} = 'mono' and cardinality(${table.inputChannels}) = 1)
        or (
          ${table.inputFormat} = 'stereo'
          and cardinality(${table.inputChannels}) = 2
          and ${table.inputChannels}[1] <> ${table.inputChannels}[2]
        )
      )
    ) or (
      ${table.kind} not in ('audio', 'aux')
      and ${table.inputSource} is null
      and ${table.inputFormat} is null
      and cardinality(${table.inputChannels}) = 0
    )`
    ),
    check(
      "mixer_channels_input_channels_check",
      sql`(
        ${table.inputSource} is null
        or (
          0 < all(${table.inputChannels})
          and (
            (${table.inputSource} = 'hardware' and 32 >= all(${table.inputChannels}))
            or (${table.inputSource} = 'bus' and 256 >= all(${table.inputChannels}))
          )
        )
      )`
    ),
    check(
      "mixer_channels_hardware_output_check",
      sql`(
      ${table.kind} = 'output'
      and cardinality(${table.hardwareOutputChannels}) = 2
      and ${table.hardwareOutputChannels}[1] <> ${table.hardwareOutputChannels}[2]
      and 0 < all(${table.hardwareOutputChannels})
    ) or (
      ${table.kind} <> 'output'
      and cardinality(${table.hardwareOutputChannels}) = 0
    )`
    )
  ]
)

export const tracks = pgTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => mixerChannels.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
    notes: text("notes").notNull().default("")
  },
  (table) => [
    uniqueIndex("tracks_channel_id_unique").on(table.channelId),
    index("tracks_sort_order_index").on(table.sortOrder, table.id),
    check("tracks_sort_order_check", sql`${table.sortOrder} >= 0`)
  ]
)

export const audioClips = pgTable(
  "audio_clips",
  {
    id: text("id").primaryKey(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startFrame: int8BigInt("start_frame").notNull(),
    sourceOffsetFrames: int8BigInt("source_offset_frames")
      .notNull()
      .default(sql`0`),
    lengthFrames: int8BigInt("length_frames").notNull(),
    fadeInFrames: int8BigInt("fade_in_frames")
      .notNull()
      .default(sql`0`),
    fadeOutFrames: int8BigInt("fade_out_frames")
      .notNull()
      .default(sql`0`)
  },
  (table) => [
    index("audio_clips_track_start").on(table.trackId, table.startFrame),
    check("audio_clips_name_check", sql`length(trim(${table.name})) > 0`),
    check("audio_clips_start_frame_check", sql`${table.startFrame} >= 0`),
    check("audio_clips_source_offset_frames_check", sql`${table.sourceOffsetFrames} >= 0`),
    check("audio_clips_length_frames_check", sql`${table.lengthFrames} > 0`),
    check("audio_clips_fade_in_frames_check", sql`${table.fadeInFrames} >= 0`),
    check("audio_clips_fade_out_frames_check", sql`${table.fadeOutFrames} >= 0`),
    check(
      "audio_clips_fade_length_check",
      sql`${table.fadeInFrames} + ${table.fadeOutFrames} <= ${table.lengthFrames}`
    )
  ]
)

export const mixerSends = pgTable(
  "mixer_sends",
  {
    id: text("id").primaryKey(),
    sourceChannelId: text("source_channel_id")
      .notNull()
      .references(() => mixerChannels.id, { onDelete: "cascade" }),
    targetChannelId: text("target_channel_id").references(() => mixerChannels.id, {
      onDelete: "cascade"
    }),
    targetBus: smallint("target_bus"),
    sortOrder: integer("sort_order").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    tap: text("tap").$type<"pre" | "post" | "post-pan">().notNull().default("post-pan"),
    levelDb: doublePrecision("level_db").notNull().default(-90)
  },
  (table) => [
    uniqueIndex("mixer_sends_source_bus_unique")
      .on(table.sourceChannelId, table.targetBus)
      .where(sql`${table.targetBus} is not null`),
    uniqueIndex("mixer_sends_source_output_unique")
      .on(table.sourceChannelId, table.targetChannelId)
      .where(sql`${table.targetChannelId} is not null`),
    index("mixer_sends_source_order").on(table.sourceChannelId, table.sortOrder),
    check("mixer_sends_sort_order_check", sql`${table.sortOrder} >= 0`),
    check("mixer_sends_tap_check", sql`${table.tap} in ('pre', 'post', 'post-pan')`),
    check("mixer_sends_level_db_check", sql`${table.levelDb} between -90 and 12`),
    check(
      "mixer_sends_target_check",
      sql`num_nonnulls(${table.targetChannelId}, ${table.targetBus}) = 1
        and (${table.targetBus} is null or ${table.targetBus} between 1 and 256)`
    )
  ]
)

export const pluginInstances = pgTable(
  "plugin_instances",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => mixerChannels.id, { onDelete: "cascade" }),
    role: text("role").$type<"instrument" | "insert">().notNull(),
    slotOrder: integer("slot_order").notNull(),
    classId: text("class_id").notNull(),
    descriptorSnapshot: text("descriptor_snapshot").notNull(),
    audioMode: text("audio_mode").$type<PluginAudioMode>().notNull().default("stereo"),
    enabled: boolean("enabled").notNull().default(true),
    componentState: bytea("component_state")
      .notNull()
      .default(sql`''::bytea`),
    controllerState: bytea("controller_state")
      .notNull()
      .default(sql`''::bytea`),
    araDocumentState: bytea("ara_document_state")
      .notNull()
      .default(sql`''::bytea`)
  },
  (table) => [
    uniqueIndex("plugin_instances_channel_role_slot_unique").on(
      table.channelId,
      table.role,
      table.slotOrder
    ),
    uniqueIndex("plugin_instances_instrument_singleton")
      .on(table.channelId)
      .where(sql`${table.role} = 'instrument'`),
    index("plugin_instances_channel_order").on(table.channelId, table.role, table.slotOrder),
    check("plugin_instances_role_check", sql`${table.role} in ('instrument', 'insert')`),
    check(
      "plugin_instances_audio_mode_check",
      sql`${table.audioMode} in ('mono', 'mono-to-stereo', 'stereo', 'dual-mono')`
    ),
    check("plugin_instances_slot_order_check", sql`${table.slotOrder} >= 0`),
    check(
      "plugin_instances_instrument_slot_check",
      sql`${table.role} <> 'instrument' or ${table.slotOrder} = 0`
    )
  ]
)

export const pluginSidechainRoutes = pgTable(
  "plugin_sidechain_routes",
  {
    pluginId: text("plugin_id")
      .notNull()
      .references(() => pluginInstances.id, { onDelete: "cascade" }),
    inputBusIndex: integer("input_bus_index").notNull(),
    sourceChannelId: text("source_channel_id")
      .notNull()
      .references(() => mixerChannels.id, { onDelete: "cascade" })
  },
  (table) => [
    primaryKey({ columns: [table.pluginId, table.inputBusIndex] }),
    index("plugin_sidechain_routes_source_channel").on(table.sourceChannelId),
    check("plugin_sidechain_routes_bus_index_check", sql`${table.inputBusIndex} >= 0`)
  ]
)

export const tempoEvents = pgTable(
  "tempo_events",
  {
    tick: int8Number("tick").primaryKey(),
    beatsPerMinute: doublePrecision("beats_per_minute").notNull()
  },
  (table) => [
    check("tempo_events_tick_check", sql`${table.tick} >= 0`),
    check("tempo_events_beats_per_minute_check", sql`${table.beatsPerMinute} > 0`)
  ]
)

export const timeSignatureEvents = pgTable(
  "time_signature_events",
  {
    tick: int8Number("tick").primaryKey(),
    numerator: smallint("numerator").notNull(),
    denominator: smallint("denominator").notNull()
  },
  (table) => [
    check("time_signature_events_tick_check", sql`${table.tick} >= 0`),
    check("time_signature_events_numerator_check", sql`${table.numerator} between 1 and 32`),
    check(
      "time_signature_events_denominator_check",
      sql`${table.denominator} in (1, 2, 4, 8, 16, 32)`
    )
  ]
)

export const keySignatureEvents = pgTable(
  "key_signature_events",
  {
    tick: int8Number("tick").primaryKey(),
    fifths: smallint("fifths").notNull(),
    mode: text("mode").notNull()
  },
  (table) => [
    check("key_signature_events_tick_check", sql`${table.tick} >= 0`),
    check("key_signature_events_fifths_check", sql`${table.fifths} between -7 and 7`),
    check("key_signature_events_mode_check", sql`${table.mode} in ('major', 'minor')`)
  ]
)

export const midiSources = pgTable(
  "midi_sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    contentHash: text("content_hash").notNull(),
    rawBytes: bytea("raw_bytes").notNull()
  },
  (table) => [
    uniqueIndex("midi_sources_content_hash_unique").on(table.contentHash),
    check("midi_sources_name_check", sql`length(trim(${table.name})) > 0`)
  ]
)

export const midiClips = pgTable(
  "midi_clips",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => midiSources.id, { onDelete: "restrict" }),
    trackId: text("track_id")
      .notNull()
      .references(() => tracks.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    startTick: int8Number("start_tick").notNull(),
    lengthTicks: int8Number("length_ticks").notNull(),
    sourceOffsetTicks: int8Number("source_offset_ticks").notNull().default(0),
    sourceLengthTicks: int8Number("source_length_ticks").notNull()
  },
  (table) => [
    index("midi_clips_track_start").on(table.trackId, table.startTick),
    check("midi_clips_name_check", sql`length(trim(${table.name})) > 0`),
    check("midi_clips_start_tick_check", sql`${table.startTick} >= 0`),
    check("midi_clips_length_ticks_check", sql`${table.lengthTicks} > 0`),
    check("midi_clips_source_offset_ticks_check", sql`${table.sourceOffsetTicks} >= 0`),
    check("midi_clips_source_length_ticks_check", sql`${table.sourceLengthTicks} > 0`),
    check(
      "midi_clips_source_window_check",
      sql`${table.sourceOffsetTicks} + ${table.lengthTicks} <= ${table.sourceLengthTicks}`
    )
  ]
)

export const midiNotes = pgTable(
  "midi_notes",
  {
    id: text("id").primaryKey(),
    clipId: text("clip_id")
      .notNull()
      .references(() => midiClips.id, { onDelete: "cascade" }),
    startTick: int8Number("start_tick").notNull(),
    durationTicks: int8Number("duration_ticks").notNull(),
    channel: smallint("channel").notNull(),
    key: smallint("key").notNull(),
    velocity: smallint("velocity").notNull(),
    releaseVelocity: smallint("release_velocity").notNull()
  },
  (table) => [
    index("midi_notes_clip_start").on(table.clipId, table.startTick),
    check("midi_notes_start_tick_check", sql`${table.startTick} >= 0`),
    check("midi_notes_duration_ticks_check", sql`${table.durationTicks} > 0`),
    check("midi_notes_channel_check", sql`${table.channel} between 0 and 15`),
    check("midi_notes_key_check", sql`${table.key} between 0 and 127`),
    check("midi_notes_velocity_check", sql`${table.velocity} between 1 and 127`),
    check("midi_notes_release_velocity_check", sql`${table.releaseVelocity} between 0 and 127`)
  ]
)

export const midiEvents = pgTable(
  "midi_events",
  {
    id: text("id").primaryKey(),
    clipId: text("clip_id")
      .notNull()
      .references(() => midiClips.id, { onDelete: "cascade" }),
    tick: int8Number("tick").notNull(),
    channel: smallint("channel"),
    kind: text("kind")
      .$type<
        | "control-change"
        | "pitch-bend"
        | "program-change"
        | "channel-pressure"
        | "poly-pressure"
        | "sysex"
      >()
      .notNull(),
    data: bytea("data").notNull()
  },
  (table) => [
    index("midi_events_clip_tick").on(table.clipId, table.tick),
    check("midi_events_tick_check", sql`${table.tick} >= 0`),
    check(
      "midi_events_channel_check",
      sql`${table.channel} is null or ${table.channel} between 0 and 15`
    ),
    check(
      "midi_events_kind_check",
      sql`${table.kind} in (
      'control-change', 'pitch-bend', 'program-change',
      'channel-pressure', 'poly-pressure', 'sysex'
    )`
    )
  ]
)

export const assetsRelations = relations(assets, ({ many }) => ({
  waveformLevels: many(assetWaveformLevels),
  audioClips: many(audioClips)
}))

export const assetWaveformLevelsRelations = relations(assetWaveformLevels, ({ one }) => ({
  asset: one(assets, {
    fields: [assetWaveformLevels.assetId],
    references: [assets.id]
  })
}))

export const mixerChannelsRelations = relations(mixerChannels, ({ many, one }) => ({
  outputChannel: one(mixerChannels, {
    fields: [mixerChannels.outputChannelId],
    references: [mixerChannels.id],
    relationName: "channelOutput"
  }),
  routedChannels: many(mixerChannels, { relationName: "channelOutput" }),
  track: one(tracks),
  plugins: many(pluginInstances),
  sourcedSends: many(mixerSends, { relationName: "sendSource" }),
  targetedSends: many(mixerSends, { relationName: "sendTarget" }),
  sourcedPluginSidechains: many(pluginSidechainRoutes, { relationName: "sidechainSource" })
}))

export const tracksRelations = relations(tracks, ({ many, one }) => ({
  channel: one(mixerChannels, {
    fields: [tracks.channelId],
    references: [mixerChannels.id]
  }),
  audioClips: many(audioClips),
  midiClips: many(midiClips)
}))

export const audioClipsRelations = relations(audioClips, ({ one }) => ({
  asset: one(assets, {
    fields: [audioClips.assetId],
    references: [assets.id]
  }),
  track: one(tracks, {
    fields: [audioClips.trackId],
    references: [tracks.id]
  })
}))

export const mixerSendsRelations = relations(mixerSends, ({ one }) => ({
  sourceChannel: one(mixerChannels, {
    fields: [mixerSends.sourceChannelId],
    references: [mixerChannels.id],
    relationName: "sendSource"
  }),
  targetChannel: one(mixerChannels, {
    fields: [mixerSends.targetChannelId],
    references: [mixerChannels.id],
    relationName: "sendTarget"
  })
}))

export const pluginInstancesRelations = relations(pluginInstances, ({ many, one }) => ({
  channel: one(mixerChannels, {
    fields: [pluginInstances.channelId],
    references: [mixerChannels.id]
  }),
  sidechainRoutes: many(pluginSidechainRoutes)
}))

export const pluginSidechainRoutesRelations = relations(pluginSidechainRoutes, ({ one }) => ({
  plugin: one(pluginInstances, {
    fields: [pluginSidechainRoutes.pluginId],
    references: [pluginInstances.id]
  }),
  sourceChannel: one(mixerChannels, {
    fields: [pluginSidechainRoutes.sourceChannelId],
    references: [mixerChannels.id],
    relationName: "sidechainSource"
  })
}))

export const midiSourcesRelations = relations(midiSources, ({ many }) => ({
  clips: many(midiClips)
}))

export const midiClipsRelations = relations(midiClips, ({ many, one }) => ({
  source: one(midiSources, {
    fields: [midiClips.sourceId],
    references: [midiSources.id]
  }),
  track: one(tracks, {
    fields: [midiClips.trackId],
    references: [tracks.id]
  }),
  notes: many(midiNotes),
  events: many(midiEvents)
}))

export const midiNotesRelations = relations(midiNotes, ({ one }) => ({
  clip: one(midiClips, {
    fields: [midiNotes.clipId],
    references: [midiClips.id]
  })
}))

export const midiEventsRelations = relations(midiEvents, ({ one }) => ({
  clip: one(midiClips, {
    fields: [midiEvents.clipId],
    references: [midiClips.id]
  })
}))

export type Project = typeof project.$inferSelect
export type Asset = typeof assets.$inferSelect
export type AssetWaveformLevel = typeof assetWaveformLevels.$inferSelect
export type MixerChannel = typeof mixerChannels.$inferSelect
export type Track = typeof tracks.$inferSelect
export type AudioClip = typeof audioClips.$inferSelect
export type MixerSend = typeof mixerSends.$inferSelect
export type PluginInstance = typeof pluginInstances.$inferSelect
export type PluginSidechainRoute = typeof pluginSidechainRoutes.$inferSelect
export type TempoEvent = typeof tempoEvents.$inferSelect
export type TimeSignatureEvent = typeof timeSignatureEvents.$inferSelect
export type KeySignatureEvent = typeof keySignatureEvents.$inferSelect
export type MidiSource = typeof midiSources.$inferSelect
export type MidiClip = typeof midiClips.$inferSelect
export type MidiNote = typeof midiNotes.$inferSelect
export type MidiEvent = typeof midiEvents.$inferSelect

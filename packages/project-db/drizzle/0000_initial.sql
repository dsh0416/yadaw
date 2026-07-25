CREATE TABLE "asset_waveform_levels" (
	"asset_id" text NOT NULL,
	"cache_version" smallint NOT NULL,
	"level" smallint NOT NULL,
	"frames_per_bucket" integer NOT NULL,
	"bucket_count" integer NOT NULL,
	"channels" smallint NOT NULL,
	"sample_rate" integer NOT NULL,
	"frame_count" bigint NOT NULL,
	"peaks" "bytea" NOT NULL,
	CONSTRAINT "asset_waveform_levels_asset_id_cache_version_level_pk" PRIMARY KEY("asset_id","cache_version","level"),
	CONSTRAINT "asset_waveform_levels_cache_version_check" CHECK ("asset_waveform_levels"."cache_version" > 0),
	CONSTRAINT "asset_waveform_levels_level_check" CHECK ("asset_waveform_levels"."level" >= 0),
	CONSTRAINT "asset_waveform_levels_frames_per_bucket_check" CHECK ("asset_waveform_levels"."frames_per_bucket" > 0),
	CONSTRAINT "asset_waveform_levels_bucket_count_check" CHECK ("asset_waveform_levels"."bucket_count" >= 0),
	CONSTRAINT "asset_waveform_levels_channels_check" CHECK ("asset_waveform_levels"."channels" > 0),
	CONSTRAINT "asset_waveform_levels_sample_rate_check" CHECK ("asset_waveform_levels"."sample_rate" > 0),
	CONSTRAINT "asset_waveform_levels_frame_count_check" CHECK ("asset_waveform_levels"."frame_count" >= 0),
	CONSTRAINT "asset_waveform_levels_peaks_length_check" CHECK (octet_length("asset_waveform_levels"."peaks") = "asset_waveform_levels"."bucket_count" * "asset_waveform_levels"."channels" * 8)
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"content_hash" text NOT NULL,
	"byte_length" bigint NOT NULL,
	"sample_rate" integer NOT NULL,
	"channels" smallint NOT NULL,
	"bit_depth" text NOT NULL,
	"frame_count" bigint NOT NULL,
	"bwf_time_reference" bigint NOT NULL,
	"large_object_oid" "oid" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_name_check" CHECK (length(trim("assets"."name")) > 0),
	CONSTRAINT "assets_mime_type_check" CHECK ("assets"."mime_type" = 'audio/x-bwf'),
	CONSTRAINT "assets_byte_length_check" CHECK ("assets"."byte_length" >= 0),
	CONSTRAINT "assets_sample_rate_check" CHECK ("assets"."sample_rate" > 0),
	CONSTRAINT "assets_channels_check" CHECK ("assets"."channels" > 0),
	CONSTRAINT "assets_bit_depth_check" CHECK ("assets"."bit_depth" in ('float32', 'pcm24', 'pcm16')),
	CONSTRAINT "assets_frame_count_check" CHECK ("assets"."frame_count" >= 0),
	CONSTRAINT "assets_bwf_time_reference_check" CHECK ("assets"."bwf_time_reference" >= 0)
);
--> statement-breakpoint
CREATE TABLE "midi_clips" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"track_id" text NOT NULL,
	"name" text NOT NULL,
	"start_tick" bigint NOT NULL,
	"length_ticks" bigint NOT NULL,
	"source_offset_ticks" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "midi_clips_name_check" CHECK (length(trim("midi_clips"."name")) > 0),
	CONSTRAINT "midi_clips_start_tick_check" CHECK ("midi_clips"."start_tick" >= 0),
	CONSTRAINT "midi_clips_length_ticks_check" CHECK ("midi_clips"."length_ticks" > 0),
	CONSTRAINT "midi_clips_source_offset_ticks_check" CHECK ("midi_clips"."source_offset_ticks" >= 0)
);
--> statement-breakpoint
CREATE TABLE "midi_events" (
	"id" text PRIMARY KEY NOT NULL,
	"clip_id" text NOT NULL,
	"tick" bigint NOT NULL,
	"channel" smallint,
	"kind" text NOT NULL,
	"data" "bytea" NOT NULL,
	CONSTRAINT "midi_events_tick_check" CHECK ("midi_events"."tick" >= 0),
	CONSTRAINT "midi_events_channel_check" CHECK ("midi_events"."channel" is null or "midi_events"."channel" between 0 and 15),
	CONSTRAINT "midi_events_kind_check" CHECK ("midi_events"."kind" in (
      'control-change', 'pitch-bend', 'program-change',
      'channel-pressure', 'poly-pressure', 'sysex'
    ))
);
--> statement-breakpoint
CREATE TABLE "midi_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"clip_id" text NOT NULL,
	"start_tick" bigint NOT NULL,
	"duration_ticks" bigint NOT NULL,
	"channel" smallint NOT NULL,
	"key" smallint NOT NULL,
	"velocity" smallint NOT NULL,
	"release_velocity" smallint NOT NULL,
	CONSTRAINT "midi_notes_start_tick_check" CHECK ("midi_notes"."start_tick" >= 0),
	CONSTRAINT "midi_notes_duration_ticks_check" CHECK ("midi_notes"."duration_ticks" > 0),
	CONSTRAINT "midi_notes_channel_check" CHECK ("midi_notes"."channel" between 0 and 15),
	CONSTRAINT "midi_notes_key_check" CHECK ("midi_notes"."key" between 0 and 127),
	CONSTRAINT "midi_notes_velocity_check" CHECK ("midi_notes"."velocity" between 1 and 127),
	CONSTRAINT "midi_notes_release_velocity_check" CHECK ("midi_notes"."release_velocity" between 0 and 127)
);
--> statement-breakpoint
CREATE TABLE "midi_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"content_hash" text NOT NULL,
	"raw_bytes" "bytea" NOT NULL,
	CONSTRAINT "midi_sources_name_check" CHECK (length(trim("midi_sources"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "mixer_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"color" text NOT NULL,
	"sort_order" integer NOT NULL,
	"input_format" text,
	"gain_db" double precision DEFAULT 0 NOT NULL,
	"pan" double precision DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"soloed" boolean DEFAULT false NOT NULL,
	"output_channel_id" text,
	"record_armed" boolean DEFAULT false NOT NULL,
	"input_channels" smallint[] DEFAULT array[]::smallint[] NOT NULL,
	"hardware_output_channels" smallint[] DEFAULT array[]::smallint[] NOT NULL,
	CONSTRAINT "mixer_channels_kind_check" CHECK ("mixer_channels"."kind" in ('audio', 'instrument', 'bus', 'master', 'output')),
	CONSTRAINT "mixer_channels_name_check" CHECK (length(trim("mixer_channels"."name")) > 0),
	CONSTRAINT "mixer_channels_color_check" CHECK ("mixer_channels"."color" ~ '^#[0-9A-Fa-f]{6}$'),
	CONSTRAINT "mixer_channels_sort_order_check" CHECK ("mixer_channels"."sort_order" >= 0),
	CONSTRAINT "mixer_channels_gain_db_check" CHECK ("mixer_channels"."gain_db" between -90 and 12),
	CONSTRAINT "mixer_channels_pan_check" CHECK ("mixer_channels"."pan" between -1 and 1),
	CONSTRAINT "mixer_channels_master_solo_check" CHECK ("mixer_channels"."kind" <> 'master' or not "mixer_channels"."soloed"),
	CONSTRAINT "mixer_channels_output_route_check" CHECK (("mixer_channels"."kind" in ('master', 'output')) = ("mixer_channels"."output_channel_id" is null)),
	CONSTRAINT "mixer_channels_input_check" CHECK ((
      "mixer_channels"."kind" = 'audio'
      and "mixer_channels"."input_format" is not null
      and (
        ("mixer_channels"."input_format" = 'mono' and cardinality("mixer_channels"."input_channels") = 1)
        or ("mixer_channels"."input_format" = 'stereo' and cardinality("mixer_channels"."input_channels") = 2)
      )
    ) or (
      "mixer_channels"."kind" <> 'audio'
      and "mixer_channels"."input_format" is null
      and cardinality("mixer_channels"."input_channels") = 0
      and not "mixer_channels"."record_armed"
    )),
	CONSTRAINT "mixer_channels_input_channels_check" CHECK (0 < all("mixer_channels"."input_channels")),
	CONSTRAINT "mixer_channels_hardware_output_check" CHECK ((
      "mixer_channels"."kind" = 'output'
      and cardinality("mixer_channels"."hardware_output_channels") = 2
      and "mixer_channels"."hardware_output_channels"[1] <> "mixer_channels"."hardware_output_channels"[2]
      and 0 < all("mixer_channels"."hardware_output_channels")
    ) or (
      "mixer_channels"."kind" <> 'output'
      and cardinality("mixer_channels"."hardware_output_channels") = 0
    ))
);
--> statement-breakpoint
CREATE TABLE "mixer_sends" (
	"id" text PRIMARY KEY NOT NULL,
	"source_channel_id" text NOT NULL,
	"target_channel_id" text NOT NULL,
	"sort_order" integer NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"tap" text DEFAULT 'post' NOT NULL,
	"level_db" double precision DEFAULT -90 NOT NULL,
	"pan" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "mixer_sends_sort_order_check" CHECK ("mixer_sends"."sort_order" >= 0),
	CONSTRAINT "mixer_sends_tap_check" CHECK ("mixer_sends"."tap" in ('pre', 'post')),
	CONSTRAINT "mixer_sends_level_db_check" CHECK ("mixer_sends"."level_db" between -90 and 12),
	CONSTRAINT "mixer_sends_pan_check" CHECK ("mixer_sends"."pan" between -1 and 1),
	CONSTRAINT "mixer_sends_distinct_channels_check" CHECK ("mixer_sends"."source_channel_id" <> "mixer_sends"."target_channel_id")
);
--> statement-breakpoint
CREATE TABLE "plugin_instances" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"role" text NOT NULL,
	"slot_order" integer NOT NULL,
	"class_id" text NOT NULL,
	"descriptor_snapshot" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"component_state" "bytea" DEFAULT ''::bytea NOT NULL,
	"controller_state" "bytea" DEFAULT ''::bytea NOT NULL,
	CONSTRAINT "plugin_instances_role_check" CHECK ("plugin_instances"."role" in ('instrument', 'insert')),
	CONSTRAINT "plugin_instances_slot_order_check" CHECK ("plugin_instances"."slot_order" >= 0),
	CONSTRAINT "plugin_instances_instrument_slot_check" CHECK ("plugin_instances"."role" <> 'instrument' or "plugin_instances"."slot_order" = 0)
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sample_rate" integer NOT NULL,
	"waveform_display_mode" text NOT NULL,
	CONSTRAINT "project_singleton_id_check" CHECK ("project"."id" = 'project'),
	CONSTRAINT "project_name_check" CHECK (length(trim("project"."name")) > 0),
	CONSTRAINT "project_sample_rate_check" CHECK ("project"."sample_rate" in (44100, 48000, 88200, 96000, 176400, 192000)),
	CONSTRAINT "project_waveform_display_mode_check" CHECK ("project"."waveform_display_mode" in ('separate', 'aggregate'))
);
--> statement-breakpoint
CREATE TABLE "tempo_events" (
	"tick" bigint PRIMARY KEY NOT NULL,
	"beats_per_minute" double precision NOT NULL,
	CONSTRAINT "tempo_events_tick_check" CHECK ("tempo_events"."tick" >= 0),
	CONSTRAINT "tempo_events_beats_per_minute_check" CHECK ("tempo_events"."beats_per_minute" > 0)
);
--> statement-breakpoint
CREATE TABLE "time_signature_events" (
	"tick" bigint PRIMARY KEY NOT NULL,
	"numerator" smallint NOT NULL,
	"denominator" smallint NOT NULL,
	CONSTRAINT "time_signature_events_tick_check" CHECK ("time_signature_events"."tick" >= 0),
	CONSTRAINT "time_signature_events_numerator_check" CHECK ("time_signature_events"."numerator" between 1 and 32),
	CONSTRAINT "time_signature_events_denominator_check" CHECK ("time_signature_events"."denominator" in (1, 2, 4, 8, 16, 32))
);
--> statement-breakpoint
CREATE TABLE "timeline_clips" (
	"id" text PRIMARY KEY NOT NULL,
	"asset_id" text NOT NULL,
	"track_id" text NOT NULL,
	"name" text NOT NULL,
	"start_frame" bigint NOT NULL,
	"source_offset_frames" bigint DEFAULT 0 NOT NULL,
	"length_frames" bigint NOT NULL,
	CONSTRAINT "timeline_clips_name_check" CHECK (length(trim("timeline_clips"."name")) > 0),
	CONSTRAINT "timeline_clips_start_frame_check" CHECK ("timeline_clips"."start_frame" >= 0),
	CONSTRAINT "timeline_clips_source_offset_frames_check" CHECK ("timeline_clips"."source_offset_frames" >= 0),
	CONSTRAINT "timeline_clips_length_frames_check" CHECK ("timeline_clips"."length_frames" > 0)
);
--> statement-breakpoint
ALTER TABLE "asset_waveform_levels" ADD CONSTRAINT "asset_waveform_levels_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midi_clips" ADD CONSTRAINT "midi_clips_source_id_midi_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."midi_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midi_clips" ADD CONSTRAINT "midi_clips_track_id_mixer_channels_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."mixer_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midi_events" ADD CONSTRAINT "midi_events_clip_id_midi_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."midi_clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "midi_notes" ADD CONSTRAINT "midi_notes_clip_id_midi_clips_id_fk" FOREIGN KEY ("clip_id") REFERENCES "public"."midi_clips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_output_channel_id_fk" FOREIGN KEY ("output_channel_id") REFERENCES "public"."mixer_channels"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mixer_sends" ADD CONSTRAINT "mixer_sends_source_channel_id_mixer_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."mixer_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mixer_sends" ADD CONSTRAINT "mixer_sends_target_channel_id_mixer_channels_id_fk" FOREIGN KEY ("target_channel_id") REFERENCES "public"."mixer_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD CONSTRAINT "plugin_instances_channel_id_mixer_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."mixer_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_clips" ADD CONSTRAINT "timeline_clips_track_id_mixer_channels_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."mixer_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assets_content_hash_unique" ON "assets" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "assets_large_object_oid_unique" ON "assets" USING btree ("large_object_oid");--> statement-breakpoint
CREATE INDEX "assets_created_at_index" ON "assets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "midi_clips_track_start" ON "midi_clips" USING btree ("track_id","start_tick");--> statement-breakpoint
CREATE INDEX "midi_events_clip_tick" ON "midi_events" USING btree ("clip_id","tick");--> statement-breakpoint
CREATE INDEX "midi_notes_clip_start" ON "midi_notes" USING btree ("clip_id","start_tick");--> statement-breakpoint
CREATE UNIQUE INDEX "midi_sources_content_hash_unique" ON "midi_sources" USING btree ("content_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mixer_master_singleton" ON "mixer_channels" USING btree ("kind") WHERE "mixer_channels"."kind" = 'master';--> statement-breakpoint
CREATE UNIQUE INDEX "mixer_output_channels_unique" ON "mixer_channels" USING btree ("hardware_output_channels") WHERE "mixer_channels"."kind" = 'output';--> statement-breakpoint
CREATE INDEX "mixer_channel_sort_order" ON "mixer_channels" USING btree ("kind","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "mixer_sends_source_target_unique" ON "mixer_sends" USING btree ("source_channel_id","target_channel_id");--> statement-breakpoint
CREATE INDEX "mixer_sends_source_order" ON "mixer_sends" USING btree ("source_channel_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_instances_channel_role_slot_unique" ON "plugin_instances" USING btree ("channel_id","role","slot_order");--> statement-breakpoint
CREATE UNIQUE INDEX "plugin_instances_instrument_singleton" ON "plugin_instances" USING btree ("channel_id") WHERE "plugin_instances"."role" = 'instrument';--> statement-breakpoint
CREATE INDEX "plugin_instances_channel_order" ON "plugin_instances" USING btree ("channel_id","role","slot_order");--> statement-breakpoint
CREATE INDEX "timeline_clips_track_start" ON "timeline_clips" USING btree ("track_id","start_frame");
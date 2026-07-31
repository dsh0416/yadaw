CREATE TABLE "tracks" (
	"id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"sort_order" integer NOT NULL,
	CONSTRAINT "tracks_sort_order_check" CHECK ("tracks"."sort_order" >= 0)
);
--> statement-breakpoint
INSERT INTO "tracks" ("id", "channel_id", "sort_order")
SELECT 'track:' || "id", "id", "sort_order"
FROM "mixer_channels"
WHERE "system_role" IS NULL
	AND "kind" IN ('audio', 'instrument');--> statement-breakpoint
ALTER TABLE "timeline_clips" RENAME TO "audio_clips";--> statement-breakpoint
ALTER TABLE "audio_clips" DROP CONSTRAINT "timeline_clips_name_check";--> statement-breakpoint
ALTER TABLE "audio_clips" DROP CONSTRAINT "timeline_clips_start_frame_check";--> statement-breakpoint
ALTER TABLE "audio_clips" DROP CONSTRAINT "timeline_clips_source_offset_frames_check";--> statement-breakpoint
ALTER TABLE "audio_clips" DROP CONSTRAINT "timeline_clips_length_frames_check";--> statement-breakpoint
ALTER TABLE "midi_clips" DROP CONSTRAINT "midi_clips_track_id_mixer_channels_id_fk";
--> statement-breakpoint
ALTER TABLE "audio_clips" DROP CONSTRAINT "timeline_clips_asset_id_assets_id_fk";
--> statement-breakpoint
ALTER TABLE "audio_clips" DROP CONSTRAINT "timeline_clips_track_id_mixer_channels_id_fk";
--> statement-breakpoint
UPDATE "audio_clips" SET "track_id" = 'track:' || "track_id";--> statement-breakpoint
UPDATE "midi_clips" SET "track_id" = 'track:' || "track_id";--> statement-breakpoint
DROP INDEX "timeline_clips_track_start";--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_channel_id_mixer_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."mixer_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tracks_channel_id_unique" ON "tracks" USING btree ("channel_id");--> statement-breakpoint
CREATE INDEX "tracks_sort_order_index" ON "tracks" USING btree ("sort_order","id");--> statement-breakpoint
ALTER TABLE "midi_clips" ADD CONSTRAINT "midi_clips_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_clips" ADD CONSTRAINT "audio_clips_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audio_clips" ADD CONSTRAINT "audio_clips_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audio_clips_track_start" ON "audio_clips" USING btree ("track_id","start_frame");--> statement-breakpoint
ALTER TABLE "audio_clips" ADD CONSTRAINT "audio_clips_name_check" CHECK (length(trim("audio_clips"."name")) > 0);--> statement-breakpoint
ALTER TABLE "audio_clips" ADD CONSTRAINT "audio_clips_start_frame_check" CHECK ("audio_clips"."start_frame" >= 0);--> statement-breakpoint
ALTER TABLE "audio_clips" ADD CONSTRAINT "audio_clips_source_offset_frames_check" CHECK ("audio_clips"."source_offset_frames" >= 0);--> statement-breakpoint
ALTER TABLE "audio_clips" ADD CONSTRAINT "audio_clips_length_frames_check" CHECK ("audio_clips"."length_frames" > 0);

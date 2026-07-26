ALTER TABLE "mixer_sends" DROP CONSTRAINT "mixer_sends_tap_check";--> statement-breakpoint
ALTER TABLE "mixer_sends" ALTER COLUMN "tap" SET DEFAULT 'post-pan';--> statement-breakpoint
ALTER TABLE "mixer_sends" ADD CONSTRAINT "mixer_sends_tap_check" CHECK ("mixer_sends"."tap" in ('pre', 'post', 'post-pan'));
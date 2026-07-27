ALTER TABLE "key_signature_events" DROP CONSTRAINT "key_signature_events_pitch_class_check";--> statement-breakpoint
ALTER TABLE "key_signature_events" ALTER COLUMN "fifths" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "key_signature_events" DROP COLUMN "pitch_class";
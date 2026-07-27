CREATE TABLE "key_signature_events" (
	"tick" bigint PRIMARY KEY NOT NULL,
	"pitch_class" smallint NOT NULL,
	"mode" text NOT NULL,
	CONSTRAINT "key_signature_events_tick_check" CHECK ("key_signature_events"."tick" >= 0),
	CONSTRAINT "key_signature_events_pitch_class_check" CHECK ("key_signature_events"."pitch_class" between 0 and 11),
	CONSTRAINT "key_signature_events_mode_check" CHECK ("key_signature_events"."mode" in ('major', 'minor'))
);
--> statement-breakpoint
INSERT INTO "key_signature_events" ("tick", "pitch_class", "mode")
SELECT 0, 0, 'major'
FROM "project"
LIMIT 1;

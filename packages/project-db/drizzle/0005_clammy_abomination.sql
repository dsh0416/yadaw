ALTER TABLE "key_signature_events" ADD COLUMN "fifths" smallint DEFAULT 0 NOT NULL;--> statement-breakpoint
UPDATE "key_signature_events"
SET "fifths" = CASE
	WHEN "mode" = 'major' THEN CASE "pitch_class"
		WHEN 0 THEN 0
		WHEN 1 THEN 7
		WHEN 2 THEN 2
		WHEN 3 THEN -3
		WHEN 4 THEN 4
		WHEN 5 THEN -1
		WHEN 6 THEN 6
		WHEN 7 THEN 1
		WHEN 8 THEN -4
		WHEN 9 THEN 3
		WHEN 10 THEN -2
		WHEN 11 THEN 5
	END
	ELSE CASE "pitch_class"
		WHEN 0 THEN -3
		WHEN 1 THEN 4
		WHEN 2 THEN -1
		WHEN 3 THEN -6
		WHEN 4 THEN 1
		WHEN 5 THEN -4
		WHEN 6 THEN 3
		WHEN 7 THEN -2
		WHEN 8 THEN -7
		WHEN 9 THEN 0
		WHEN 10 THEN -5
		WHEN 11 THEN 2
	END
END;--> statement-breakpoint
ALTER TABLE "key_signature_events" ADD CONSTRAINT "key_signature_events_fifths_check" CHECK ("key_signature_events"."fifths" between -7 and 7);

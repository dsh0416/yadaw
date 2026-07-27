ALTER TABLE "mixer_channels" ADD COLUMN "system_role" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mixer_system_role_singleton" ON "mixer_channels" USING btree ("system_role") WHERE "mixer_channels"."system_role" is not null;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_system_role_check" CHECK ("mixer_channels"."system_role" is null or "mixer_channels"."system_role" = 'metronome');--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_system_role_kind_check" CHECK ("mixer_channels"."system_role" is null or "mixer_channels"."kind" = 'instrument');--> statement-breakpoint
INSERT INTO "mixer_channels" (
  "id",
  "kind",
  "system_role",
  "name",
  "color",
  "sort_order",
  "input_format",
  "gain_db",
  "pan",
  "muted",
  "soloed",
  "output_channel_id",
  "record_armed",
  "input_channels",
  "hardware_output_channels"
)
SELECT
  'metronome',
  'instrument',
  'metronome',
  'Metronome',
  '#AD8CFF',
  0,
  NULL,
  0,
  0,
  true,
  false,
  "id",
  false,
  array[]::smallint[],
  array[]::smallint[]
FROM "mixer_channels"
WHERE "kind" = 'output'
ORDER BY "sort_order", "id"
LIMIT 1;--> statement-breakpoint
INSERT INTO "plugin_instances" (
  "id",
  "channel_id",
  "role",
  "slot_order",
  "class_id",
  "descriptor_snapshot",
  "enabled"
)
SELECT
  'metronome-instrument',
  'metronome',
  'instrument',
  0,
  'F310A5DEDA34820C9E068A5753F83ADE',
  '{"source":{"kind":"builtin","id":"dev.yadaw.metronome"},"classId":"F310A5DEDA34820C9E068A5753F83ADE","modulePath":"YADAW Metronome.vst3","name":"YADAW Metronome","vendor":"YADAW","version":"","category":"Instrument|Synth","kind":"instrument","architecture":"unknown","buses":[{"direction":"output","kind":"main","name":"Stereo Out","channels":2,"defaultActive":true}],"hasEditor":true,"compatibility":"compatible","compatibilityReason":null}',
  true
FROM "mixer_channels"
WHERE "id" = 'metronome' AND "system_role" = 'metronome';

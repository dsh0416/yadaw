ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_kind_check";--> statement-breakpoint
ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_output_route_check";--> statement-breakpoint
ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_input_check";--> statement-breakpoint
ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_input_channels_check";--> statement-breakpoint
ALTER TABLE "mixer_sends" DROP CONSTRAINT "mixer_sends_distinct_channels_check";--> statement-breakpoint
DROP INDEX "mixer_sends_source_target_unique";--> statement-breakpoint
ALTER TABLE "mixer_sends" ALTER COLUMN "target_channel_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD COLUMN "input_source" text;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD COLUMN "output_bus" smallint;--> statement-breakpoint
ALTER TABLE "mixer_sends" ADD COLUMN "target_bus" smallint;--> statement-breakpoint
UPDATE "mixer_sends" AS "send"
SET
  "target_bus" = LEAST("target"."sort_order" + 1, 256),
  "target_channel_id" = null
FROM "mixer_channels" AS "target"
WHERE
  "send"."target_channel_id" = "target"."id"
  AND "target"."kind" = 'bus';--> statement-breakpoint
UPDATE "mixer_channels" AS "source"
SET
  "output_bus" = LEAST("target"."sort_order" + 1, 256),
  "output_channel_id" = null
FROM "mixer_channels" AS "target"
WHERE
  "source"."output_channel_id" = "target"."id"
  AND "target"."kind" = 'bus';--> statement-breakpoint
UPDATE "mixer_channels"
SET
  "kind" = 'aux',
  "input_source" = 'bus',
  "input_format" = 'mono',
  "input_channels" = ARRAY[LEAST("sort_order" + 1, 256)::smallint]
WHERE "kind" = 'bus';--> statement-breakpoint
UPDATE "mixer_channels"
SET "input_source" = 'hardware'
WHERE "kind" = 'audio';--> statement-breakpoint
CREATE UNIQUE INDEX "mixer_sends_source_bus_unique" ON "mixer_sends" USING btree ("source_channel_id","target_bus") WHERE "mixer_sends"."target_bus" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "mixer_sends_source_output_unique" ON "mixer_sends" USING btree ("source_channel_id","target_channel_id") WHERE "mixer_sends"."target_channel_id" is not null;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_output_bus_check" CHECK ("mixer_channels"."output_bus" is null or "mixer_channels"."output_bus" between 1 and 256);--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_kind_check" CHECK ("mixer_channels"."kind" in ('audio', 'instrument', 'aux', 'master', 'output'));--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_output_route_check" CHECK ((
        "mixer_channels"."kind" in ('master', 'output')
        and "mixer_channels"."output_channel_id" is null
        and "mixer_channels"."output_bus" is null
      ) or (
        "mixer_channels"."kind" not in ('master', 'output')
        and num_nonnulls("mixer_channels"."output_channel_id", "mixer_channels"."output_bus") = 1
      ));--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_input_check" CHECK ((
      "mixer_channels"."kind" in ('audio', 'aux')
      and "mixer_channels"."input_source" is not null
      and "mixer_channels"."input_format" is not null
      and (
        ("mixer_channels"."input_format" = 'mono' and cardinality("mixer_channels"."input_channels") = 1)
        or (
          "mixer_channels"."input_format" = 'stereo'
          and cardinality("mixer_channels"."input_channels") = 2
          and "mixer_channels"."input_channels"[1] <> "mixer_channels"."input_channels"[2]
        )
      )
      and ("mixer_channels"."kind" = 'audio' or not "mixer_channels"."record_armed")
    ) or (
      "mixer_channels"."kind" not in ('audio', 'aux')
      and "mixer_channels"."input_source" is null
      and "mixer_channels"."input_format" is null
      and cardinality("mixer_channels"."input_channels") = 0
      and not "mixer_channels"."record_armed"
    ));--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_input_channels_check" CHECK ((
        "mixer_channels"."input_source" is null
        or (
          0 < all("mixer_channels"."input_channels")
          and (
            ("mixer_channels"."input_source" = 'hardware' and 32 >= all("mixer_channels"."input_channels"))
            or ("mixer_channels"."input_source" = 'bus' and 256 >= all("mixer_channels"."input_channels"))
          )
        )
      ));--> statement-breakpoint
ALTER TABLE "mixer_sends" ADD CONSTRAINT "mixer_sends_target_check" CHECK (num_nonnulls("mixer_sends"."target_channel_id", "mixer_sends"."target_bus") = 1
        and ("mixer_sends"."target_bus" is null or "mixer_sends"."target_bus" between 1 and 256));

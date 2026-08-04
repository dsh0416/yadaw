ALTER TABLE "plugin_instances" ADD COLUMN "locator_format" text;
--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "artifact_path" text;
--> statement-breakpoint
ALTER TABLE "plugin_instances" ADD COLUMN "native_id" text;
--> statement-breakpoint

UPDATE "plugin_instances"
SET
  "locator_format" = 'vst3',
  "artifact_path" = COALESCE("descriptor_snapshot"::jsonb ->> 'modulePath', ''),
  "native_id" = "class_id";
--> statement-breakpoint

UPDATE "plugin_instances"
SET "descriptor_snapshot" = jsonb_set(
  jsonb_set(
    "descriptor_snapshot"::jsonb,
    '{locator}',
    jsonb_build_object(
      'format', 'vst3',
      'artifactPath', "artifact_path",
      'nativeId', "native_id"
    ),
    true
  ),
  '{buses}',
  COALESCE(
    (
      SELECT jsonb_agg(
        bus || jsonb_build_object(
          'portKey', format(
            'vst3:audio:%s:%s',
            bus ->> 'direction',
            bus ->> 'index'
          )
        )
        ORDER BY ordinal
      )
      FROM jsonb_array_elements(
        COALESCE("descriptor_snapshot"::jsonb -> 'buses', '[]'::jsonb)
      ) WITH ORDINALITY AS value(bus, ordinal)
    ),
    '[]'::jsonb
  ),
  true
)::text;
--> statement-breakpoint

ALTER TABLE "plugin_instances" ALTER COLUMN "locator_format" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_instances" ALTER COLUMN "artifact_path" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_instances" ALTER COLUMN "native_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_instances"
  ADD CONSTRAINT "plugin_instances_format_check"
  CHECK ("locator_format" IN ('vst3', 'clap'));
--> statement-breakpoint

CREATE TABLE "plugin_state_chunks" (
  "plugin_id" text NOT NULL,
  "chunk_key" text NOT NULL,
  "bytes" bytea DEFAULT ''::bytea NOT NULL,
  CONSTRAINT "plugin_state_chunks_plugin_id_chunk_key_pk"
    PRIMARY KEY("plugin_id", "chunk_key"),
  CONSTRAINT "plugin_state_chunks_plugin_id_plugin_instances_id_fk"
    FOREIGN KEY ("plugin_id") REFERENCES "public"."plugin_instances"("id")
    ON DELETE cascade ON UPDATE no action,
  CONSTRAINT "plugin_state_chunks_key_check" CHECK (length("chunk_key") > 0)
);
--> statement-breakpoint

INSERT INTO "plugin_state_chunks" ("plugin_id", "chunk_key", "bytes")
SELECT "id", 'component', "component_state" FROM "plugin_instances"
UNION ALL
SELECT "id", 'controller', "controller_state" FROM "plugin_instances"
UNION ALL
SELECT "id", 'ara-document', "ara_document_state" FROM "plugin_instances";
--> statement-breakpoint

ALTER TABLE "plugin_sidechain_routes" ADD COLUMN "input_port_key" text;
--> statement-breakpoint
UPDATE "plugin_sidechain_routes"
SET "input_port_key" = format('vst3:audio:input:%s', "input_bus_index");
--> statement-breakpoint
ALTER TABLE "plugin_sidechain_routes" ALTER COLUMN "input_port_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "plugin_sidechain_routes"
  DROP CONSTRAINT "plugin_sidechain_routes_plugin_id_input_bus_index_pk";
--> statement-breakpoint
ALTER TABLE "plugin_sidechain_routes"
  ADD CONSTRAINT "plugin_sidechain_routes_plugin_id_input_port_key_pk"
  PRIMARY KEY("plugin_id", "input_port_key");
--> statement-breakpoint
ALTER TABLE "plugin_sidechain_routes"
  ADD CONSTRAINT "plugin_sidechain_routes_port_key_check"
  CHECK (length("input_port_key") > 0);
--> statement-breakpoint
ALTER TABLE "plugin_sidechain_routes"
  DROP CONSTRAINT "plugin_sidechain_routes_bus_index_check";
--> statement-breakpoint

ALTER TABLE "plugin_sidechain_routes" DROP COLUMN "input_bus_index";
--> statement-breakpoint
ALTER TABLE "plugin_instances" DROP COLUMN "class_id";
--> statement-breakpoint
ALTER TABLE "plugin_instances" DROP COLUMN "component_state";
--> statement-breakpoint
ALTER TABLE "plugin_instances" DROP COLUMN "controller_state";
--> statement-breakpoint
ALTER TABLE "plugin_instances" DROP COLUMN "ara_document_state";

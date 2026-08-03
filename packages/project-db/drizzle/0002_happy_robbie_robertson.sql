CREATE TABLE "plugin_sidechain_routes" (
	"plugin_id" text NOT NULL,
	"input_bus_index" integer NOT NULL,
	"source_channel_id" text NOT NULL,
	CONSTRAINT "plugin_sidechain_routes_plugin_id_input_bus_index_pk" PRIMARY KEY("plugin_id","input_bus_index"),
	CONSTRAINT "plugin_sidechain_routes_bus_index_check" CHECK ("plugin_sidechain_routes"."input_bus_index" >= 0)
);
--> statement-breakpoint
ALTER TABLE "plugin_sidechain_routes" ADD CONSTRAINT "plugin_sidechain_routes_plugin_id_plugin_instances_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugin_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plugin_sidechain_routes" ADD CONSTRAINT "plugin_sidechain_routes_source_channel_id_mixer_channels_id_fk" FOREIGN KEY ("source_channel_id") REFERENCES "public"."mixer_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_sidechain_routes_source_channel" ON "plugin_sidechain_routes" USING btree ("source_channel_id");
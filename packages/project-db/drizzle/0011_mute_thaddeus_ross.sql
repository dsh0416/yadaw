ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_input_monitoring_check";--> statement-breakpoint
ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_input_check";--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD COLUMN "midi_input_port_id" text;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD COLUMN "midi_input_port_name" text;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD COLUMN "midi_input_channel" smallint;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_record_armed_check" CHECK (("mixer_channels"."kind" = 'audio' or ("mixer_channels"."kind" = 'instrument' and "mixer_channels"."system_role" is null))
        or not "mixer_channels"."record_armed");--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_midi_input_check" CHECK ((
        "mixer_channels"."kind" = 'instrument'
        and "mixer_channels"."system_role" is null
        and (
          ("mixer_channels"."midi_input_port_id" is null and "mixer_channels"."midi_input_port_name" is null)
          or ("mixer_channels"."midi_input_port_id" is not null and "mixer_channels"."midi_input_port_name" is not null)
        )
        and ("mixer_channels"."midi_input_channel" is null or "mixer_channels"."midi_input_channel" between 0 and 15)
      ) or (
        not ("mixer_channels"."kind" = 'instrument' and "mixer_channels"."system_role" is null)
        and "mixer_channels"."midi_input_port_id" is null
        and "mixer_channels"."midi_input_port_name" is null
        and "mixer_channels"."midi_input_channel" is null
      ));--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_input_monitoring_check" CHECK (("mixer_channels"."kind" = 'audio' or ("mixer_channels"."kind" = 'instrument' and "mixer_channels"."system_role" is null))
        or not "mixer_channels"."input_monitoring");--> statement-breakpoint
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
    ) or (
      "mixer_channels"."kind" not in ('audio', 'aux')
      and "mixer_channels"."input_source" is null
      and "mixer_channels"."input_format" is null
      and cardinality("mixer_channels"."input_channels") = 0
    ));
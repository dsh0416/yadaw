ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_input_monitoring_check";--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_input_monitoring_check" CHECK (("mixer_channels"."kind" in ('audio', 'aux') or ("mixer_channels"."kind" = 'instrument' and "mixer_channels"."system_role" is null))
        or not "mixer_channels"."input_monitoring");
ALTER TABLE "mixer_channels" DROP CONSTRAINT "mixer_channels_input_channels_check";--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD COLUMN "application_capture" jsonb;--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_application_capture_check" CHECK ((
        ("mixer_channels"."input_source" = 'application' and "mixer_channels"."application_capture" is not null)
        or ("mixer_channels"."input_source" <> 'application' and "mixer_channels"."application_capture" is null)
        or ("mixer_channels"."input_source" is null and "mixer_channels"."application_capture" is null)
      ));--> statement-breakpoint
ALTER TABLE "mixer_channels" ADD CONSTRAINT "mixer_channels_input_channels_check" CHECK ((
        "mixer_channels"."input_source" is null
        or (
          0 < all("mixer_channels"."input_channels")
          and (
            ("mixer_channels"."input_source" = 'hardware' and 32 >= all("mixer_channels"."input_channels"))
            or ("mixer_channels"."input_source" = 'bus' and 256 >= all("mixer_channels"."input_channels"))
            or ("mixer_channels"."input_source" = 'application' and 2 >= all("mixer_channels"."input_channels"))
          )
        )
      ));

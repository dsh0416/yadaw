import type { UiCascadingSelectGroup } from "@heron/ui"
import type { MixerBusState, MixerChannelState, MixerRouteTarget } from "@heron/contracts"

export type MixerRouteGroupsTranslator = (key: string, params?: Record<string, unknown>) => string

export function mixerRouteGroups(
  targets: readonly MixerRouteTarget[],
  buses: readonly MixerBusState[],
  outputs: readonly MixerChannelState[],
  t: MixerRouteGroupsTranslator
): readonly UiCascadingSelectGroup[] {
  return [
    {
      label: t("mixer.routeGroups.buses"),
      options: targets
        .filter(
          (target): target is Extract<MixerRouteTarget, { kind: "bus" }> => target.kind === "bus"
        )
        .map((target) => ({
          value: `bus:${target.bus}`,
          label: buses.find((bus) => bus.channel === target.bus)?.name ?? `BUS ${target.bus}`
        }))
    },
    {
      label: t("mixer.routeGroups.outputs"),
      options: targets
        .filter(
          (target): target is Extract<MixerRouteTarget, { kind: "output" }> =>
            target.kind === "output"
        )
        .map((target) => ({
          value: `output:${target.channelId}`,
          label:
            outputs.find((output) => output.id === target.channelId)?.name ??
            t("mixer.routeGroups.missingOutput")
        }))
    }
  ]
}

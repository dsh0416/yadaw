import type { UiCascadingSelectGroup } from "@yadaw/ui"
import type { MixerBusState, MixerChannelState, MixerRouteTarget } from "@yadaw/contracts"

export function mixerRouteGroups(
  targets: readonly MixerRouteTarget[],
  buses: readonly MixerBusState[],
  outputs: readonly MixerChannelState[]
): readonly UiCascadingSelectGroup[] {
  return [
    {
      label: "Buses",
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
      label: "Outputs",
      options: targets
        .filter(
          (target): target is Extract<MixerRouteTarget, { kind: "output" }> =>
            target.kind === "output"
        )
        .map((target) => ({
          value: `output:${target.channelId}`,
          label: outputs.find((output) => output.id === target.channelId)?.name ?? "Missing output"
        }))
    }
  ]
}

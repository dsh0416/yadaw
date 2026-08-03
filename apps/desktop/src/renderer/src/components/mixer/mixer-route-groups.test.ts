import { describe, expect, it } from "vitest"
import type { MixerBusState, MixerChannelState, MixerRouteTarget } from "@heron/contracts"
import { mixerRouteGroups } from "./mixer-route-groups"

const t = (key: string): string => key

describe("mixerRouteGroups", () => {
  it("groups bus and output route targets with resolved labels", () => {
    const targets: MixerRouteTarget[] = [
      { kind: "bus", bus: 1 },
      { kind: "bus", bus: 3 },
      { kind: "output", channelId: "output-a" },
      { kind: "output", channelId: "missing" }
    ]
    const buses: MixerBusState[] = [{ channel: 1, name: "Reverb" }]
    const outputs: MixerChannelState[] = [
      {
        id: "output-a",
        kind: "output",
        systemRole: null,
        name: "Main Out",
        color: "#fff",
        sortOrder: 0,
        inputSource: null,
        inputFormat: null,
        gainDb: 0,
        pan: 0,
        muted: false,
        soloed: false,
        outputChannelId: null,
        outputBus: null,
        recordArmed: false,
        inputMonitoring: false,
        inputChannels: [],
        hardwareOutputChannels: [1, 2]
      }
    ]

    expect(mixerRouteGroups(targets, buses, outputs, t)).toEqual([
      {
        label: "mixer.routeGroups.buses",
        options: [
          { value: "bus:1", label: "Reverb" },
          { value: "bus:3", label: "BUS 3" }
        ]
      },
      {
        label: "mixer.routeGroups.outputs",
        options: [
          { value: "output:output-a", label: "Main Out" },
          { value: "output:missing", label: "mixer.routeGroups.missingOutput" }
        ]
      }
    ])
  })
})

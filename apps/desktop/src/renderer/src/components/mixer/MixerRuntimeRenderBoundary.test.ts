import { describe, expect, it } from "vitest"
import MixerChannelMeterDisplaySource from "./MixerChannelMeterDisplay.vue?raw"
import MixerConsoleSource from "./MixerConsole.vue?raw"
import ArrangementWorkspaceSource from "../studio/ArrangementWorkspace.vue?raw"
import TrackGainControlSource from "../studio/TrackGainControl.vue?raw"
import StudioViewSource from "../../views/StudioView.vue?raw"

describe("mixer runtime render boundary", () => {
  it("keeps high-frequency meter subscriptions out of composition surfaces", () => {
    expect(MixerConsoleSource).not.toContain("meterFor(")
    expect(ArrangementWorkspaceSource).not.toContain("meterFor(")
    expect(StudioViewSource).not.toContain("meterFor(")
  })

  it("subscribes to runtime telemetry inside the focused meter display", () => {
    expect(MixerChannelMeterDisplaySource).toContain("useMixerRuntimeStore")
    expect(MixerChannelMeterDisplaySource).toContain("runtimeStore.meterFor(props.channelId)")
    expect(TrackGainControlSource).toContain("useMixerRuntimeStore")
  })
})

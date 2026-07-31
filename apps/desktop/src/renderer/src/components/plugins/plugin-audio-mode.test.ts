import { describe, expect, it } from "vitest"
import {
  pluginAudioModeBadge,
  pluginAudioModeInputWidth,
  pluginAudioModeOptions,
  pluginAudioModeOutputWidth
} from "./plugin-audio-mode"

const t = (key: string): string => key

describe("plugin audio mode helpers", () => {
  it("lists instrument modes and filters effect modes by input width", () => {
    expect(pluginAudioModeOptions("instrument", undefined, t).map((option) => option.value)).toEqual(
      ["mono", "stereo"]
    )
    expect(pluginAudioModeOptions("effect", undefined, t)).toEqual([])
    expect(pluginAudioModeOptions("effect", "mono", t).map((option) => option.value)).toEqual([
      "mono",
      "mono-to-stereo"
    ])
    expect(pluginAudioModeOptions("effect", "stereo", t).map((option) => option.value)).toEqual([
      "stereo",
      "dual-mono"
    ])
  })

  it("maps badges and signal widths for each audio mode", () => {
    expect(pluginAudioModeBadge("mono")).toBe("M")
    expect(pluginAudioModeBadge("mono-to-stereo")).toBe("M→S")
    expect(pluginAudioModeBadge("stereo")).toBe("S")
    expect(pluginAudioModeBadge("dual-mono")).toBe("2×M")

    expect(pluginAudioModeInputWidth("mono")).toBe("mono")
    expect(pluginAudioModeInputWidth("mono-to-stereo")).toBe("mono")
    expect(pluginAudioModeInputWidth("stereo")).toBe("stereo")
    expect(pluginAudioModeInputWidth("dual-mono")).toBe("stereo")

    expect(pluginAudioModeOutputWidth("mono")).toBe("mono")
    expect(pluginAudioModeOutputWidth("mono-to-stereo")).toBe("stereo")
    expect(pluginAudioModeOutputWidth("stereo")).toBe("stereo")
    expect(pluginAudioModeOutputWidth("dual-mono")).toBe("stereo")
  })
})

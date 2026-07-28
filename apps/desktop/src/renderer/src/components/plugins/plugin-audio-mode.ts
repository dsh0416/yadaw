import type { PluginAudioMode, PluginDescriptor } from "@yadaw/contracts"

export interface PluginSelection {
  descriptor: PluginDescriptor
  audioMode: PluginAudioMode
}

export type PluginSignalWidth = "mono" | "stereo"

export interface PluginAudioModeOption {
  value: PluginAudioMode
  badge: string
  label: string
  detail: string
}

const INSTRUMENT_MODES: readonly PluginAudioModeOption[] = [
  { value: "mono", badge: "M", label: "Mono", detail: "1 channel output" },
  { value: "stereo", badge: "S", label: "Stereo", detail: "2 channel output" }
]

const EFFECT_MODES: readonly PluginAudioModeOption[] = [
  { value: "mono", badge: "M", label: "Mono", detail: "1 → 1" },
  { value: "mono-to-stereo", badge: "M→S", label: "Mono to stereo", detail: "1 → 2" },
  { value: "stereo", badge: "S", label: "Stereo", detail: "2 → 2" },
  { value: "dual-mono", badge: "2×M", label: "Dual mono", detail: "2 × (1 → 1)" }
]

export function pluginAudioModeOptions(
  kind: PluginDescriptor["kind"],
  inputWidth?: PluginSignalWidth
): readonly PluginAudioModeOption[] {
  if (kind === "instrument") return INSTRUMENT_MODES
  if (!inputWidth) return []
  return EFFECT_MODES.filter((option) => pluginAudioModeInputWidth(option.value) === inputWidth)
}

export function pluginAudioModeBadge(mode: PluginAudioMode): string {
  return EFFECT_MODES.find((option) => option.value === mode)?.badge ?? mode
}

export function pluginAudioModeInputWidth(mode: PluginAudioMode): PluginSignalWidth {
  return mode === "mono" || mode === "mono-to-stereo" ? "mono" : "stereo"
}

export function pluginAudioModeOutputWidth(mode: PluginAudioMode): PluginSignalWidth {
  return mode === "mono" ? "mono" : "stereo"
}

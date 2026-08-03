import type { PluginAudioMode, PluginDescriptor } from "@heron/contracts"

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

export type PluginAudioModeTranslator = (key: string) => string

function instrumentModes(t: PluginAudioModeTranslator): readonly PluginAudioModeOption[] {
  return [
    {
      value: "mono",
      badge: "M",
      label: t("plugins.audioMode.mono.label"),
      detail: t("plugins.audioMode.mono.detailInstrument")
    },
    {
      value: "stereo",
      badge: "S",
      label: t("plugins.audioMode.stereo.label"),
      detail: t("plugins.audioMode.stereo.detailInstrument")
    }
  ]
}

function effectModes(t: PluginAudioModeTranslator): readonly PluginAudioModeOption[] {
  return [
    {
      value: "mono",
      badge: "M",
      label: t("plugins.audioMode.mono.label"),
      detail: t("plugins.audioMode.mono.detailEffect")
    },
    {
      value: "mono-to-stereo",
      badge: "M→S",
      label: t("plugins.audioMode.monoToStereo.label"),
      detail: t("plugins.audioMode.monoToStereo.detail")
    },
    {
      value: "stereo",
      badge: "S",
      label: t("plugins.audioMode.stereo.label"),
      detail: t("plugins.audioMode.stereo.detailEffect")
    },
    {
      value: "dual-mono",
      badge: "2×M",
      label: t("plugins.audioMode.dualMono.label"),
      detail: t("plugins.audioMode.dualMono.detail")
    }
  ]
}

export function pluginAudioModeOptions(
  kind: PluginDescriptor["kind"],
  inputWidth: PluginSignalWidth | undefined,
  t: PluginAudioModeTranslator
): readonly PluginAudioModeOption[] {
  if (kind === "instrument") return instrumentModes(t)
  if (!inputWidth) return []
  return effectModes(t).filter((option) => pluginAudioModeInputWidth(option.value) === inputWidth)
}

export function pluginAudioModeBadge(mode: PluginAudioMode): string {
  const badges: Partial<Record<PluginAudioMode, string>> = {
    mono: "M",
    "mono-to-stereo": "M→S",
    stereo: "S",
    "dual-mono": "2×M"
  }
  return badges[mode] ?? mode
}

export function pluginAudioModeInputWidth(mode: PluginAudioMode): PluginSignalWidth {
  return mode === "mono" || mode === "mono-to-stereo" ? "mono" : "stereo"
}

export function pluginAudioModeOutputWidth(mode: PluginAudioMode): PluginSignalWidth {
  return mode === "mono" ? "mono" : "stereo"
}

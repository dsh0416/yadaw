import type { AppLocale, RecentProject, RecordingBitDepth, ThemePreference } from "./project"
import type { MidiSyncPreferences } from "./midi"
import type { ShortcutPreferences } from "./shortcuts"
import type { ApplicationSettingsRef } from "./rpc"

export type MeterPeakHold = "800ms" | "2s" | "4s" | "infinite"
export type MeterReturnRate = "iec-type-i"
export type MidiCenterCStandard = "yamaha-c3" | "roland-c4"
export type AudioHostThreadSetting = "auto" | number
export type PluginEditorMode = "native" | "parameters"

export interface PluginEditorPreference {
  mode: PluginEditorMode
  zoomPercent: number
}

export interface AudioHostRuntimePreferences {
  workerThreads: AudioHostThreadSetting
  maxBlockingThreads: AudioHostThreadSetting
  egressConcurrency: AudioHostThreadSetting
}

export interface ResolvedAudioHostRuntimePreferences {
  workerThreads: number
  maxBlockingThreads: number
  egressConcurrency: number
}

export interface ApplicationSettings {
  swapDirectory: string
  recordingBitDepth: RecordingBitDepth
  theme: ThemePreference
  locale: AppLocale
  meterPeakHold: MeterPeakHold
  meterReturnRate: MeterReturnRate
  midiCenterCStandard: MidiCenterCStandard
  softwareMonitoringEnabled: boolean
  lowLatencyPluginBudgetMs?: number
  midiSync: MidiSyncPreferences
  audioHostRuntime: AudioHostRuntimePreferences
  pluginEditors: Record<string, PluginEditorPreference>
  shortcuts: ShortcutPreferences
  recentProjects: RecentProject[]
}
export interface ApplicationSettingsResourceSnapshot {
  settings: ApplicationSettingsRef
  revision: number
  value: ApplicationSettings
}

export type ApplicationSettingsPatch = Partial<
  Pick<
    ApplicationSettings,
    | "swapDirectory"
    | "recordingBitDepth"
    | "theme"
    | "locale"
    | "meterPeakHold"
    | "meterReturnRate"
    | "midiCenterCStandard"
    | "lowLatencyPluginBudgetMs"
  >
>

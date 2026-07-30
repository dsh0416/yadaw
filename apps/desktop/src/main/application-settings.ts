import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import { MAX_MIDI_INPUT_OFFSET_MS } from "@yadaw/contracts"
import type {
  ApplicationSettings,
  ApplicationSettingsPatch,
  AudioHostRuntimePreferences,
  MeterPeakHold,
  MeterReturnRate,
  MidiCenterCStandard,
  MidiSyncPreferences,
  PluginEditorPreference,
  RecordingBitDepth,
  ThemePreference
} from "@yadaw/contracts"
import { DEFAULT_LOCALE, isAppLocale } from "../shared/i18n"

export const DEFAULT_PLUGIN_EDITOR_PREFERENCE: Readonly<PluginEditorPreference> = {
  mode: "native",
  zoomPercent: 100
}

const VST3_CLASS_ID = /^[0-9A-F]{32}$/u

function isRecordingBitDepth(value: unknown): value is RecordingBitDepth {
  return value === "float32" || value === "pcm24" || value === "pcm16"
}

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "light" || value === "dark" || value === "system"
}

function isMeterPeakHold(value: unknown): value is MeterPeakHold {
  return value === "800ms" || value === "2s" || value === "4s" || value === "infinite"
}

function isMeterReturnRate(value: unknown): value is MeterReturnRate {
  return value === "iec-type-i"
}

function isMidiCenterCStandard(value: unknown): value is MidiCenterCStandard {
  return value === "yamaha-c3" || value === "roland-c4"
}

export function validateMidiSyncPreferences(value: unknown): MidiSyncPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("MIDI sync preferences must be an object")
  }
  const input = value as Partial<MidiSyncPreferences>
  if (typeof input.enabled !== "boolean") {
    throw new TypeError("External MIDI sync enabled must be a boolean")
  }
  if (input.sourcePortId !== null && typeof input.sourcePortId !== "string") {
    throw new TypeError("MIDI clock source port ID must be a string or null")
  }
  if (input.sourcePortName !== null && typeof input.sourcePortName !== "string") {
    throw new TypeError("MIDI clock source port name must be a string or null")
  }
  if (
    (input.sourcePortId === null) !== (input.sourcePortName === null) ||
    (typeof input.sourcePortId === "string" && !input.sourcePortId.trim()) ||
    (typeof input.sourcePortName === "string" && !input.sourcePortName.trim())
  ) {
    throw new TypeError("MIDI clock source ID and name must be set together")
  }
  if (
    !input.inputOffsetsMs ||
    typeof input.inputOffsetsMs !== "object" ||
    Array.isArray(input.inputOffsetsMs)
  ) {
    throw new TypeError("MIDI input offsets must be an object")
  }
  const inputOffsetsMs: Record<string, number> = {}
  for (const [portId, offset] of Object.entries(input.inputOffsetsMs)) {
    if (
      !portId.trim() ||
      typeof offset !== "number" ||
      !Number.isFinite(offset) ||
      offset < -MAX_MIDI_INPUT_OFFSET_MS ||
      offset > MAX_MIDI_INPUT_OFFSET_MS
    ) {
      throw new TypeError(
        `MIDI input offsets must be finite values from -${MAX_MIDI_INPUT_OFFSET_MS} to ${MAX_MIDI_INPUT_OFFSET_MS} ms`
      )
    }
    inputOffsetsMs[portId] = offset
  }
  return {
    enabled: input.enabled,
    sourcePortId: input.sourcePortId ?? null,
    sourcePortName: input.sourcePortName ?? null,
    inputOffsetsMs
  }
}

function runtimeThreadSetting(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string
): "auto" | number {
  if (value === "auto") return value
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new TypeError(`${name} must be Auto or an integer from ${minimum} to ${maximum}`)
  }
  return value as number
}

export function validateAudioHostRuntimePreferences(value: unknown): AudioHostRuntimePreferences {
  if (!value || typeof value !== "object") {
    throw new TypeError("Audio host runtime preferences must be an object")
  }
  const input = value as Partial<AudioHostRuntimePreferences>
  const preferences = {
    workerThreads: runtimeThreadSetting(input.workerThreads, 1, 8, "Worker threads"),
    maxBlockingThreads: runtimeThreadSetting(input.maxBlockingThreads, 2, 16, "Blocking threads"),
    egressConcurrency: runtimeThreadSetting(input.egressConcurrency, 1, 4, "Egress concurrency")
  }
  if (
    typeof preferences.egressConcurrency === "number" &&
    typeof preferences.maxBlockingThreads === "number" &&
    preferences.egressConcurrency > preferences.maxBlockingThreads
  ) {
    throw new TypeError("Egress concurrency cannot exceed blocking threads")
  }
  return preferences
}

function normalizePluginClassId(value: string): string {
  const classId = value.trim().toUpperCase()
  if (!VST3_CLASS_ID.test(classId)) {
    throw new TypeError("VST3 class ID must contain exactly 32 hexadecimal characters")
  }
  return classId
}

export function validatePluginEditorPreference(value: unknown): PluginEditorPreference {
  if (!value || typeof value !== "object") {
    throw new TypeError("Plugin editor preference must be an object")
  }
  const input = value as Partial<PluginEditorPreference>
  if (input.mode !== "native" && input.mode !== "parameters") {
    throw new TypeError("Unsupported plugin editor mode")
  }
  if (
    !Number.isInteger(input.zoomPercent) ||
    (input.zoomPercent as number) < 50 ||
    (input.zoomPercent as number) > 400
  ) {
    throw new TypeError("Plugin editor zoom must be an integer from 50 to 400")
  }
  return {
    mode: input.mode,
    zoomPercent: input.zoomPercent as number
  }
}

function pluginEditorPreferences(value: unknown): Record<string, PluginEditorPreference> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const preferences: Record<string, PluginEditorPreference> = {}
  for (const [rawClassId, rawPreference] of Object.entries(value)) {
    try {
      const classId = normalizePluginClassId(rawClassId)
      preferences[classId] = validatePluginEditorPreference(rawPreference)
    } catch {
      // Settings are user-editable; ignore only the malformed per-plugin entry.
    }
  }
  return preferences
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r")
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EPERM" && code !== "EINVAL") throw error
  }
}

export class ApplicationSettingsStore {
  readonly path: string
  private settings: ApplicationSettings | null = null

  constructor(private readonly userData: string) {
    this.path = join(userData, "settings.json")
  }

  private defaults(): ApplicationSettings {
    return {
      swapDirectory: join(this.userData, "swap"),
      recordingBitDepth: "float32",
      theme: "system",
      locale: DEFAULT_LOCALE,
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      midiCenterCStandard: "roland-c4",
      softwareMonitoringEnabled: false,
      midiSync: {
        enabled: false,
        sourcePortId: null,
        sourcePortName: null,
        inputOffsetsMs: {}
      },
      audioHostRuntime: {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      pluginEditors: {},
      recentProjects: []
    }
  }

  async get(): Promise<ApplicationSettings> {
    if (this.settings) return structuredClone(this.settings)
    let value = this.defaults()
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<ApplicationSettings>
      value = {
        swapDirectory:
          typeof raw.swapDirectory === "string" && raw.swapDirectory
            ? raw.swapDirectory
            : value.swapDirectory,
        recordingBitDepth: isRecordingBitDepth(raw.recordingBitDepth)
          ? raw.recordingBitDepth
          : value.recordingBitDepth,
        theme: isThemePreference(raw.theme) ? raw.theme : value.theme,
        locale: isAppLocale(raw.locale) ? raw.locale : value.locale,
        meterPeakHold: isMeterPeakHold(raw.meterPeakHold) ? raw.meterPeakHold : value.meterPeakHold,
        meterReturnRate: isMeterReturnRate(raw.meterReturnRate)
          ? raw.meterReturnRate
          : value.meterReturnRate,
        midiCenterCStandard: isMidiCenterCStandard(raw.midiCenterCStandard)
          ? raw.midiCenterCStandard
          : value.midiCenterCStandard,
        softwareMonitoringEnabled:
          typeof raw.softwareMonitoringEnabled === "boolean"
            ? raw.softwareMonitoringEnabled
            : value.softwareMonitoringEnabled,
        midiSync: (() => {
          try {
            return validateMidiSyncPreferences(raw.midiSync)
          } catch {
            return value.midiSync
          }
        })(),
        audioHostRuntime: (() => {
          try {
            return validateAudioHostRuntimePreferences(raw.audioHostRuntime)
          } catch {
            return value.audioHostRuntime
          }
        })(),
        pluginEditors: pluginEditorPreferences(raw.pluginEditors),
        recentProjects: Array.isArray(raw.recentProjects)
          ? raw.recentProjects
              .filter(
                (recent) =>
                  typeof recent?.path === "string" &&
                  typeof recent.name === "string" &&
                  typeof recent.openedAt === "number"
              )
              .slice(0, 20)
          : []
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    await mkdir(value.swapDirectory, { recursive: true })
    this.settings = value
    return structuredClone(value)
  }

  async update(patch: ApplicationSettingsPatch): Promise<ApplicationSettings> {
    const current = await this.get()
    if (patch.swapDirectory !== undefined) {
      if (!patch.swapDirectory.trim()) throw new TypeError("Swap directory cannot be empty")
      await mkdir(patch.swapDirectory, { recursive: true })
      current.swapDirectory = patch.swapDirectory
    }
    if (patch.recordingBitDepth !== undefined) {
      if (!isRecordingBitDepth(patch.recordingBitDepth))
        throw new TypeError("Unsupported recording bit depth")
      current.recordingBitDepth = patch.recordingBitDepth
    }
    if (patch.theme !== undefined) {
      if (!isThemePreference(patch.theme)) throw new TypeError("Unsupported theme preference")
      current.theme = patch.theme
    }
    if (patch.locale !== undefined) {
      if (!isAppLocale(patch.locale)) throw new TypeError("Unsupported locale preference")
      current.locale = patch.locale
    }
    if (patch.meterPeakHold !== undefined) {
      if (!isMeterPeakHold(patch.meterPeakHold)) throw new TypeError("Unsupported meter peak hold")
      current.meterPeakHold = patch.meterPeakHold
    }
    if (patch.meterReturnRate !== undefined) {
      if (!isMeterReturnRate(patch.meterReturnRate))
        throw new TypeError("Unsupported meter return rate")
      current.meterReturnRate = patch.meterReturnRate
    }
    if (patch.midiCenterCStandard !== undefined) {
      if (!isMidiCenterCStandard(patch.midiCenterCStandard))
        throw new TypeError("Unsupported MIDI center C standard")
      current.midiCenterCStandard = patch.midiCenterCStandard
    }
    return this.write(current)
  }

  async addRecent(path: string, name: string): Promise<ApplicationSettings> {
    const current = await this.get()
    current.recentProjects = [
      { path, name, openedAt: Date.now() },
      ...current.recentProjects.filter((recent) => recent.path !== path)
    ].slice(0, 20)
    return this.write(current)
  }

  async configureAudioHostRuntime(
    preferences: AudioHostRuntimePreferences
  ): Promise<ApplicationSettings> {
    const current = await this.get()
    current.audioHostRuntime = validateAudioHostRuntimePreferences(preferences)
    return this.write(current)
  }

  async configureMidiInput(preferences: MidiSyncPreferences): Promise<ApplicationSettings> {
    const current = await this.get()
    current.midiSync = validateMidiSyncPreferences(preferences)
    return this.write(current)
  }

  async setSoftwareMonitoringEnabled(enabled: boolean): Promise<ApplicationSettings> {
    const current = await this.get()
    current.softwareMonitoringEnabled = enabled
    return this.write(current)
  }

  async pluginEditorPreference(classId: string): Promise<PluginEditorPreference> {
    const normalizedClassId = normalizePluginClassId(classId)
    const current = await this.get()
    return structuredClone(
      current.pluginEditors[normalizedClassId] ?? DEFAULT_PLUGIN_EDITOR_PREFERENCE
    )
  }

  async setPluginEditorPreference(
    classId: string,
    preference: PluginEditorPreference
  ): Promise<ApplicationSettings> {
    const normalizedClassId = normalizePluginClassId(classId)
    const current = await this.get()
    current.pluginEditors[normalizedClassId] = validatePluginEditorPreference(preference)
    return this.write(current)
  }

  private async write(settings: ApplicationSettings): Promise<ApplicationSettings> {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.tmp`
    const handle = await open(temporary, "w")
    try {
      await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8")
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.path)
    await syncDirectory(dirname(this.path))
    this.settings = structuredClone(settings)
    return structuredClone(settings)
  }
}

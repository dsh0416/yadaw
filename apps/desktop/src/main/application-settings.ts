import { mkdir, open, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"
import type {
  ApplicationSettings,
  ApplicationSettingsPatch,
  MeterPeakHold,
  MeterReturnRate,
  RecordingBitDepth,
  ThemePreference
} from "@yadaw/contracts"

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
      meterPeakHold: "800ms",
      meterReturnRate: "iec-type-i",
      recentProjects: []
    }
  }

  async get(): Promise<ApplicationSettings> {
    if (this.settings) return structuredClone(this.settings)
    let value = this.defaults()
    try {
      const raw = JSON.parse(await readFile(this.path, "utf8")) as Partial<ApplicationSettings>
      value = {
        swapDirectory: typeof raw.swapDirectory === "string" && raw.swapDirectory
          ? raw.swapDirectory
          : value.swapDirectory,
        recordingBitDepth: isRecordingBitDepth(raw.recordingBitDepth)
          ? raw.recordingBitDepth
          : value.recordingBitDepth,
        theme: isThemePreference(raw.theme) ? raw.theme : value.theme,
        meterPeakHold: isMeterPeakHold(raw.meterPeakHold)
          ? raw.meterPeakHold
          : value.meterPeakHold,
        meterReturnRate: isMeterReturnRate(raw.meterReturnRate)
          ? raw.meterReturnRate
          : value.meterReturnRate,
        recentProjects: Array.isArray(raw.recentProjects)
          ? raw.recentProjects.filter((recent) =>
            typeof recent?.path === "string" &&
            typeof recent.name === "string" &&
            typeof recent.openedAt === "number"
          ).slice(0, 20)
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
      if (!isRecordingBitDepth(patch.recordingBitDepth)) throw new TypeError("Unsupported recording bit depth")
      current.recordingBitDepth = patch.recordingBitDepth
    }
    if (patch.theme !== undefined) {
      if (!isThemePreference(patch.theme)) throw new TypeError("Unsupported theme preference")
      current.theme = patch.theme
    }
    if (patch.meterPeakHold !== undefined) {
      if (!isMeterPeakHold(patch.meterPeakHold)) throw new TypeError("Unsupported meter peak hold")
      current.meterPeakHold = patch.meterPeakHold
    }
    if (patch.meterReturnRate !== undefined) {
      if (!isMeterReturnRate(patch.meterReturnRate)) throw new TypeError("Unsupported meter return rate")
      current.meterReturnRate = patch.meterReturnRate
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

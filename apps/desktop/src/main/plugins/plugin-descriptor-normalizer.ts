import { basename } from "node:path"
import {
  defaultPluginCategories,
  parsePluginCategories,
  pluginLooksLikeInstrument,
  type PluginAudioMode,
  type PluginDescriptor
} from "@heron/contracts"

const AUDIO_MODES = ["mono", "mono-to-stereo", "stereo", "dual-mono"] as const
const INSTRUMENT_SOFT_MODES: PluginAudioMode[] = ["mono", "stereo"]
const EFFECT_SOFT_MODES: PluginAudioMode[] = ["mono", "mono-to-stereo", "stereo", "dual-mono"]

function isPluginAudioMode(value: unknown): value is PluginAudioMode {
  return AUDIO_MODES.some((mode) => mode === value)
}

function busesForMode(kind: PluginDescriptor["kind"], mode: PluginAudioMode) {
  const inputChannels = mode === "stereo" || mode === "dual-mono" ? 2 : 1
  const outputChannels = mode === "mono" ? 1 : 2
  const buses: PluginDescriptor["buses"] = []
  if (kind === "effect") {
    buses.push({
      index: 0,
      direction: "input",
      kind: "main",
      name: inputChannels === 1 ? "Mono In" : "Stereo In",
      channels: inputChannels,
      defaultActive: true
    })
  }
  buses.push({
    index: 0,
    direction: "output",
    kind: "main",
    name: outputChannels === 1 ? "Mono Out" : "Stereo Out",
    channels: outputChannels,
    defaultActive: true
  })
  return buses
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null
}

function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : []
}

function moduleInfoClasses(moduleInfo: Record<string, unknown> | null): unknown[] {
  return Array.isArray(moduleInfo?.["Classes"]) ? moduleInfo["Classes"] : []
}

function hasAudioModuleClasses(moduleInfo: Record<string, unknown> | null): boolean {
  return moduleInfoClasses(moduleInfo).some((value) => {
    const classInfo = record(value)
    return textValue(classInfo?.["Category"]) === "Audio Module Class"
  })
}

/** Build catalog entries from moduleinfo.json without loading the VST3 binary. */
export function descriptorsFromModuleInfo(
  bundlePath: string,
  moduleInfo: Record<string, unknown> | null
): PluginDescriptor[] {
  const factory = record(moduleInfo?.["Factory Info"])
  const classes = moduleInfoClasses(moduleInfo)
  const vendor = textValue(factory?.["Vendor"], "Unknown vendor")
  const fallbackName = basename(bundlePath).replace(/\.vst3$/i, "")
  if (!hasAudioModuleClasses(moduleInfo)) {
    return [
      {
        source: { kind: "external" },
        classId: `unprobed:${bundlePath}`,
        modulePath: bundlePath,
        name: fallbackName,
        vendor,
        version: textValue(moduleInfo?.["Version"], ""),
        categories: defaultPluginCategories("effect"),
        kind: "effect",
        architecture: process.arch,
        buses: [],
        supportedAudioModes: [],
        hasEditor: false,
        compatibility: "load-error",
        compatibilityReason: "Native VST3 factory enumeration is required for this module"
      }
    ]
  }
  return classes.flatMap((value) => {
    const classInfo = record(value)
    if (!classInfo || textValue(classInfo["Category"]) !== "Audio Module Class") return []
    const categories = parsePluginCategories(stringList(classInfo["Sub Categories"]))
    const kind = pluginLooksLikeInstrument(categories) ? "instrument" : "effect"
    // Soft catalog metadata: advertise host-supported layouts. Insert-time
    // activation still validates the real processor setup.
    const supportedAudioModes = kind === "instrument" ? INSTRUMENT_SOFT_MODES : EFFECT_SOFT_MODES
    const preferredMode =
      supportedAudioModes.find((mode) => mode === "stereo") ??
      supportedAudioModes.find((mode) => mode !== "dual-mono") ??
      "stereo"
    return [
      {
        source: { kind: "external" },
        classId: textValue(classInfo["CID"], `unprobed:${bundlePath}`),
        modulePath: bundlePath,
        name: textValue(classInfo["Name"], fallbackName),
        vendor: textValue(classInfo["Vendor"], vendor),
        version: textValue(classInfo["Version"], textValue(moduleInfo?.["Version"])),
        categories: categories.length > 0 ? categories : defaultPluginCategories(kind),
        kind,
        architecture: process.arch,
        supportedAudioModes,
        buses: busesForMode(kind, preferredMode),
        hasEditor: true,
        compatibility: "compatible" as const,
        compatibilityReason: null
      }
    ]
  })
}

interface ProbeOutput {
  module?: {
    path?: string
    vendor?: string
    classes?: Array<{
      classId?: string
      name?: string
      vendor?: string
      version?: string
      categories?: string[]
      /** @deprecated Probe payloads before categories[]; accepted for transition. */
      category?: string
      initialized?: boolean
      sample32?: boolean
      hasEditor?: boolean
      audioInputs?: number
      audioOutputs?: number
      eventInputs?: number
      supportedAudioModes?: unknown[]
      buses?: Array<{
        index?: number
        direction?: string
        kind?: string
        name?: string
        channels?: number
        defaultActive?: boolean
      }>
      ara?: {
        factoryClassId?: string
        factoryId?: string
        documentArchiveId?: string
        lowestApiGeneration?: number
        highestApiGeneration?: number
        playbackTransformationFlags?: number
        supportsStoringAudioFileChunks?: boolean
      } | null
    }>
  }
}

export function descriptorFromProbe(
  bundlePath: string,
  factoryVendor: string,
  value: NonNullable<NonNullable<ProbeOutput["module"]>["classes"]>[number]
): PluginDescriptor | null {
  const classId = textValue(value.classId)
  if (!classId) return null
  const categories = parsePluginCategories(value.categories ?? value.category)
  const kind = pluginLooksLikeInstrument(categories) ? "instrument" : "effect"
  const resolvedCategories = categories.length > 0 ? categories : defaultPluginCategories(kind)
  const araFactoryClassId = textValue(value.ara?.factoryClassId)
  const probedModes = (value.supportedAudioModes ?? []).filter(isPluginAudioMode)
  const nativeModes = probedModes.filter((mode) =>
    kind === "instrument" ? mode === "mono" || mode === "stereo" : mode !== "dual-mono"
  )
  const supportedAudioModes: PluginAudioMode[] =
    kind === "effect" && !araFactoryClassId && nativeModes.includes("mono")
      ? [...nativeModes, "dual-mono"]
      : nativeModes
  let compatibility: PluginDescriptor["compatibility"] = "compatible"
  let compatibilityReason: string | null = null
  if (!value.initialized) {
    compatibility = "load-error"
    compatibilityReason = "Plugin initialization failed"
  } else if (!value.sample32) {
    compatibility = "unsupported-sample-format"
    compatibilityReason = "Plugin does not support 32-bit floating-point processing"
  } else if (
    kind === "instrument" &&
    ((value.eventInputs ?? 0) < 1 || supportedAudioModes.length === 0)
  ) {
    compatibility = "unsupported-buses"
    compatibilityReason = "Instrument requires an event input and a mono or stereo main output"
  } else if (kind === "effect" && supportedAudioModes.length === 0) {
    compatibility = "unsupported-buses"
    compatibilityReason = "Effect requires a supported mono/stereo main input and output layout"
  }
  const preferredMode =
    supportedAudioModes.find((mode) => mode === "stereo") ??
    supportedAudioModes.find((mode) => mode !== "dual-mono") ??
    "stereo"
  const probedBuses = (value.buses ?? []).flatMap<PluginDescriptor["buses"][number]>((bus) => {
    if (
      !Number.isSafeInteger(bus.index) ||
      bus.index! < 0 ||
      (bus.direction !== "input" && bus.direction !== "output") ||
      (bus.kind !== "main" && bus.kind !== "aux") ||
      !Number.isSafeInteger(bus.channels) ||
      bus.channels! < 0
    ) {
      return []
    }
    return [
      {
        index: bus.index!,
        direction: bus.direction,
        kind: bus.kind,
        name: textValue(bus.name, `${bus.kind === "main" ? "Main" : "Aux"} ${bus.index! + 1}`),
        channels: bus.channels!,
        defaultActive: bus.defaultActive === true
      }
    ]
  })
  const buses = probedBuses.length > 0 ? probedBuses : busesForMode(kind, preferredMode)
  const mainInputs = buses.filter((bus) => bus.direction === "input" && bus.kind === "main")
  const mainOutputs = buses.filter((bus) => bus.direction === "output" && bus.kind === "main")
  if (
    compatibility === "compatible" &&
    ((kind === "instrument" && mainInputs.length !== 0) ||
      (kind === "effect" && mainInputs.length !== 1) ||
      mainOutputs.length !== 1)
  ) {
    compatibility = "unsupported-buses"
    compatibilityReason =
      kind === "instrument"
        ? "Instrument requires no main audio input and one supported main output"
        : "Effect requires one supported main input and output; auxiliary inputs are supported"
  }
  return {
    source: { kind: "external" },
    classId,
    modulePath: bundlePath,
    name: textValue(value.name, basename(bundlePath).replace(/\.vst3$/i, "")),
    vendor: textValue(value.vendor, factoryVendor || "Unknown vendor"),
    version: textValue(value.version),
    categories: resolvedCategories,
    kind,
    architecture: process.arch,
    buses,
    supportedAudioModes,
    hasEditor: value.hasEditor === true,
    ...(araFactoryClassId
      ? {
          ara: {
            apiGeneration: 2 as const,
            factoryClassId: araFactoryClassId,
            factoryId: textValue(value.ara?.factoryId),
            documentArchiveId: textValue(value.ara?.documentArchiveId),
            lowestApiGeneration: value.ara?.lowestApiGeneration ?? 4,
            highestApiGeneration: value.ara?.highestApiGeneration ?? 4,
            playbackTransformationFlags: value.ara?.playbackTransformationFlags ?? 0,
            supportsStoringAudioFileChunks: value.ara?.supportsStoringAudioFileChunks === true
          }
        }
      : {}),
    compatibility,
    compatibilityReason
  }
}

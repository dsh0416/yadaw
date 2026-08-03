import { readFile, readdir, stat } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import {
  defaultPluginCategories,
  normalizePluginDescriptor,
  parsePluginCategories,
  pluginLooksLikeInstrument,
  type PluginCatalogSnapshot,
  type PluginAudioMode,
  type PluginDescriptor,
  type PluginParameterChange,
  type PluginParameterInfo,
  type PluginRuntimeStatus,
  type PluginScanEvent,
  type PluginScanRequest
} from "@heron/contracts"
import { PluginCatalogCache } from "./plugin-catalog-cache"
import { parseProbeStdout } from "./plugin-descriptor-decoder"
import { PluginScanner } from "./plugin-scanner"
import { PluginRuntimeService, type PluginRuntime } from "./plugin-runtime-service"

export { parseProbeStdout } from "./plugin-descriptor-decoder"

const SCANNER_VERSION = 8
const execFileAsync = promisify(execFile)
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

const BUILTIN_PLUGINS = [
  {
    id: "live.minori.heron.gain",
    bundleName: "Heron Gain.vst3",
    classId: "46774F504DF84B4AC1F308AB88DD3677",
    name: "Heron Gain",
    kind: "effect" as const
  },
  {
    id: "live.minori.heron.sine",
    bundleName: "Heron Sine.vst3",
    classId: "C1351DFA4DDD4B4AC1F30896F6D9DF76",
    name: "Heron Sine",
    kind: "instrument" as const
  },
  {
    id: "live.minori.heron.metronome",
    bundleName: "Heron Metronome.vst3",
    classId: "8CD16A11027ACC7FDF0C1419E86D1024",
    name: "Heron Metronome",
    kind: "instrument" as const
  }
] as const

type ScanListener = (event: PluginScanEvent) => void

interface PluginFingerprint {
  mtimeMs: number
  size: number
}

interface StoredCatalog extends PluginCatalogSnapshot {
  fingerprints?: Record<string, PluginFingerprint>
}

interface CachedBundleReuse {
  force: boolean
  retryQuarantined: boolean
  fingerprintMatches: boolean
  previousPlugins: PluginDescriptor[]
}

export function canReuseCachedBundle({
  force,
  retryQuarantined,
  fingerprintMatches,
  previousPlugins
}: CachedBundleReuse): boolean {
  return (
    !force &&
    fingerprintMatches &&
    previousPlugins.length > 0 &&
    (!retryQuarantined || previousPlugins.every((plugin) => plugin.compatibility !== "quarantined"))
  )
}

function defaultPluginPaths(): string[] {
  if (process.platform === "win32") {
    return [
      join(process.env.COMMONPROGRAMFILES ?? "C:\\Program Files\\Common Files", "VST3"),
      join(
        process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
        "Programs",
        "Common",
        "VST3"
      )
    ]
  }
  if (process.platform === "darwin") {
    return ["/Library/Audio/Plug-Ins/VST3", join(homedir(), "Library", "Audio", "Plug-Ins", "VST3")]
  }
  return ["/usr/lib/vst3", "/usr/local/lib/vst3", join(homedir(), ".vst3")]
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

async function discoverBundles(root: string): Promise<string[]> {
  const bundles: string[] = []
  const pending = [root]
  while (pending.length > 0) {
    const directory = pending.pop()
    if (!directory) continue
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.name.toLowerCase().endsWith(".vst3")) {
        bundles.push(path)
      } else if (entry.isDirectory()) {
        pending.push(path)
      }
    }
  }
  return bundles.sort((left, right) => left.localeCompare(right))
}

async function readModuleInfo(bundlePath: string): Promise<Record<string, unknown> | null> {
  for (const path of [
    join(bundlePath, "Contents", "Resources", "moduleinfo.json"),
    join(bundlePath, "moduleinfo.json")
  ]) {
    try {
      return record(JSON.parse(await readFile(path, "utf8")))
    } catch {
      // Older modules do not have moduleinfo.json and require the native probe.
    }
  }
  return null
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

function hasAraMainFactoryClass(moduleInfo: Record<string, unknown> | null): boolean {
  return moduleInfoClasses(moduleInfo).some((value) => {
    const classInfo = record(value)
    return textValue(classInfo?.["Category"]) === "ARA Main Factory Class"
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

export class PluginCatalogService {
  private readonly cache: PluginCatalogCache
  private catalog: PluginCatalogSnapshot = {
    scannerVersion: SCANNER_VERSION,
    scanning: false,
    scannedAt: null,
    plugins: []
  }
  private readonly listeners = new Set<ScanListener>()
  private fingerprints: Record<string, PluginFingerprint> = {}
  private readonly scanner = new PluginScanner<PluginScanRequest, PluginCatalogSnapshot>()
  private readonly runtime = new PluginRuntimeService()
  private readonly runtimeBundleProbes = new Map<string, Promise<PluginDescriptor[]>>()

  constructor(
    userData: string,
    private readonly probePath: string,
    private readonly builtinDirectory: string
  ) {
    this.cache = new PluginCatalogCache(join(userData, "plugin-catalog.json"))
  }

  attachRuntime(runtime: PluginRuntime): void {
    this.runtime.attach(runtime)
  }

  async initialize(): Promise<void> {
    const parsed = await this.cache.load<StoredCatalog>()
    if (parsed?.scannerVersion === SCANNER_VERSION && Array.isArray(parsed.plugins)) {
      this.catalog = {
        ...parsed,
        scanning: false,
        plugins: parsed.plugins.map((plugin) => normalizePluginDescriptor(plugin))
      }
      this.fingerprints = parsed.fingerprints ?? {}
    }
    await this.refreshBuiltins()
  }

  private async refreshBuiltins(): Promise<void> {
    const external = this.catalog.plugins.filter((plugin) => plugin.source.kind === "external")
    const builtins: PluginDescriptor[] = []
    for (const spec of BUILTIN_PLUGINS) {
      const modulePath = join(this.builtinDirectory, spec.bundleName)
      try {
        const descriptors = await this.probe(modulePath)
        const descriptor = descriptors.find((candidate) => candidate.classId === spec.classId)
        if (!descriptor) throw new Error(`Built-in Class ID changed; expected ${spec.classId}`)
        builtins.push({
          ...descriptor,
          source: { kind: "builtin", id: spec.id },
          vendor: descriptor.vendor === "Unknown vendor" ? "Heron Studio" : descriptor.vendor
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Built-in VST3 probe failed"
        const inputBus = {
          index: 0,
          direction: "input" as const,
          kind: "main" as const,
          name: "Stereo In",
          channels: 2,
          defaultActive: true
        }
        const outputBus = {
          index: 0,
          direction: "output" as const,
          kind: "main" as const,
          name: "Stereo Out",
          channels: 2,
          defaultActive: true
        }
        builtins.push({
          source: { kind: "builtin", id: spec.id },
          classId: spec.classId,
          modulePath,
          name: spec.name,
          vendor: "Heron Studio",
          version: "",
          categories: defaultPluginCategories(spec.kind),
          kind: spec.kind,
          architecture: process.arch,
          buses: spec.kind === "instrument" ? [outputBus] : [inputBus, outputBus],
          // Keep project graph validation working when a built-in probe fails:
          // default projects still seed stereo metronome/instrument instances.
          supportedAudioModes: spec.kind === "instrument" ? ["mono", "stereo"] : ["stereo"],
          hasEditor: true,
          compatibility: "load-error",
          compatibilityReason: reason
        })
      }
    }
    const builtinClassIds = new Set(builtins.map((plugin) => plugin.classId))
    this.catalog = {
      ...this.catalog,
      plugins: [...builtins, ...external.filter((plugin) => !builtinClassIds.has(plugin.classId))]
    }
  }

  resolveDescriptor(snapshot: PluginDescriptor): PluginDescriptor {
    const descriptor = this.catalog.plugins.find((candidate) => {
      if (snapshot.source.kind === "builtin") {
        return (
          candidate.source.kind === "builtin" &&
          candidate.source.id === snapshot.source.id &&
          candidate.classId === snapshot.classId
        )
      }
      return (
        candidate.source.kind === "external" &&
        candidate.classId === snapshot.classId &&
        candidate.modulePath === snapshot.modulePath
      )
    })
    return normalizePluginDescriptor(descriptor ? structuredClone(descriptor) : snapshot)
  }

  async resolveDescriptorForRuntime(snapshot: PluginDescriptor): Promise<PluginDescriptor> {
    const resolved = this.resolveDescriptor(snapshot)
    if (resolved.source.kind === "builtin") return resolved
    let pending = this.runtimeBundleProbes.get(resolved.modulePath)
    if (!pending) {
      pending = this.probe(resolved.modulePath, "deep")
      this.runtimeBundleProbes.set(resolved.modulePath, pending)
    }
    try {
      const descriptors = await pending
      const byClassId = new Map(descriptors.map((descriptor) => [descriptor.classId, descriptor]))
      this.catalog = {
        ...this.catalog,
        plugins: this.catalog.plugins.map((descriptor) =>
          descriptor.source.kind === "external" && descriptor.modulePath === resolved.modulePath
            ? (byClassId.get(descriptor.classId) ?? descriptor)
            : descriptor
        )
      }
      return structuredClone(
        descriptors.find((descriptor) => descriptor.classId === resolved.classId) ?? resolved
      )
    } catch {
      this.runtimeBundleProbes.delete(resolved.modulePath);
      // The audio host still owns the authoritative load attempt. A failed
      // isolated capability probe must not make an otherwise loadable project unavailable.
      return resolved
    }
  }

  subscribe(listener: ScanListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(event: PluginScanEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  list(): PluginCatalogSnapshot {
    return structuredClone(this.catalog)
  }

  scan(request: PluginScanRequest = {}): Promise<PluginCatalogSnapshot> {
    return this.scanner.run(request, (value) =>
      this.scanNow(value).catch((error: unknown) => {
        this.catalog = { ...this.catalog, scanning: false }
        throw error
      })
    )
  }

  private async scanNow(request: PluginScanRequest): Promise<PluginCatalogSnapshot> {
    // Incremental scans reuse descriptors when mtime/size fingerprints match.
    // Forced scans (manual Rescan) and changed/new/quarantined-retry bundles
    // use lightweight discovery only: moduleinfo.json when present, otherwise
    // an isolated soft factory probe. Processors are never instantiated here.
    const knownExternalRoots = this.catalog.plugins
      .filter((plugin) => plugin.source.kind === "external")
      .map((plugin) => dirname(plugin.modulePath))
    const roots = [
      ...new Set([...(request.paths ?? []), ...knownExternalRoots, ...defaultPluginPaths()])
    ]
    const bundles = (await Promise.all(roots.map(discoverBundles))).flat()
    this.catalog = { ...this.catalog, scanning: true }
    this.publish({ type: "started", total: bundles.length })
    const plugins: PluginDescriptor[] = []
    const fingerprints: Record<string, PluginFingerprint> = {}
    for (const [index, bundlePath] of bundles.entries()) {
      this.publish({
        type: "progress",
        completed: index,
        total: bundles.length,
        path: bundlePath
      })
      const bundleStat = await stat(bundlePath)
      const fingerprint = { mtimeMs: bundleStat.mtimeMs, size: bundleStat.size }
      fingerprints[bundlePath] = fingerprint
      const previousFingerprint = this.fingerprints[bundlePath]
      const previousPlugins = this.catalog.plugins.filter(
        (plugin) => plugin.modulePath === bundlePath
      )
      const unchanged = canReuseCachedBundle({
        force: request.force === true,
        retryQuarantined: request.retryQuarantined === true,
        fingerprintMatches:
          previousFingerprint?.mtimeMs === fingerprint.mtimeMs &&
          previousFingerprint.size === fingerprint.size,
        previousPlugins
      })
      if (unchanged) {
        plugins.push(...previousPlugins)
        continue
      }
      try {
        plugins.push(...(await this.discoverBundle(bundlePath)))
      } catch (error) {
        const reason = error instanceof Error ? error.message : "VST3 discovery failed"
        this.publish({ type: "quarantined", path: bundlePath, reason })
        const fallback = descriptorsFromModuleInfo(bundlePath, await readModuleInfo(bundlePath))
        plugins.push(
          ...fallback.map((plugin) => ({
            ...plugin,
            compatibility: "quarantined" as const,
            compatibilityReason: reason
          }))
        )
      }
    }
    const builtins = this.catalog.plugins.filter((plugin) => plugin.source.kind === "builtin")
    const builtinClassIds = new Set(builtins.map((plugin) => plugin.classId))
    const unique = new Map<string, PluginDescriptor>(
      builtins.map((plugin) => [plugin.classId, plugin])
    )
    for (const plugin of plugins) {
      if (!builtinClassIds.has(plugin.classId) && !unique.has(plugin.classId)) {
        unique.set(plugin.classId, plugin)
      }
    }
    this.catalog = {
      scannerVersion: SCANNER_VERSION,
      scanning: false,
      scannedAt: Date.now(),
      plugins: [...unique.values()].sort(
        (left, right) =>
          Number(right.source.kind === "builtin") - Number(left.source.kind === "builtin") ||
          left.name.localeCompare(right.name) ||
          left.vendor.localeCompare(right.vendor)
      )
    }
    this.fingerprints = fingerprints
    await this.cache.store({ ...this.catalog, fingerprints: this.fingerprints })
    this.publish({ type: "completed", catalog: this.list() })
    return this.list()
  }

  /**
   * Lightweight catalog discovery: prefer moduleinfo.json (no binary load).
   * Bundles that advertise an ARA Main Factory Class still need a soft factory
   * probe for factory IDs. Other missing-moduleinfo bundles use the same soft
   * probe. Processors are never instantiated here.
   */
  private async discoverBundle(bundlePath: string): Promise<PluginDescriptor[]> {
    const moduleInfo = await readModuleInfo(bundlePath)
    if (hasAudioModuleClasses(moduleInfo) && !hasAraMainFactoryClass(moduleInfo)) {
      return descriptorsFromModuleInfo(bundlePath, moduleInfo)
    }
    return this.probe(bundlePath, "soft")
  }

  private async probe(
    bundlePath: string,
    mode: "soft" | "deep" = "deep"
  ): Promise<PluginDescriptor[]> {
    const { stdout } = await execFileAsync(
      this.probePath,
      mode === "soft" ? ["--soft", bundlePath] : [bundlePath],
      {
        timeout: 600_000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: {
          ...process.env,
          ...(mode === "soft" ? { HERON_VST3_PROBE_MODE: "soft" } : {})
        }
      }
    )
    const parsed = parseProbeStdout(stdout)
    const module = parsed.module
    if (!module || !Array.isArray(module.classes)) {
      throw new Error("VST3 probe returned an invalid descriptor")
    }
    const factoryVendor = textValue(module.vendor)
    const descriptors = module.classes.flatMap((classInfo) => {
      const descriptor = descriptorFromProbe(bundlePath, factoryVendor, classInfo)
      return descriptor ? [descriptor] : []
    })
    if (descriptors.length === 0) throw new Error("Module has no VST3 Audio Module classes")
    return descriptors
  }

  async openEditor(instanceId: string): Promise<PluginRuntimeStatus> {
    return this.runtime.openEditor(instanceId)
  }

  async closeEditor(instanceId: string): Promise<void> {
    await this.runtime.closeEditor(instanceId)
  }

  parameters(instanceId: string): Promise<PluginParameterInfo[]> {
    return this.runtime.parameters(instanceId)
  }

  async setParameter(change: PluginParameterChange): Promise<void> {
    await this.runtime.setParameter(change)
  }
}

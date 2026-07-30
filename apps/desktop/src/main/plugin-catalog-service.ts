import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import type {
  PluginCatalogSnapshot,
  PluginAudioMode,
  PluginDescriptor,
  PluginEditorMode,
  PluginParameterChange,
  PluginParameterInfo,
  PluginRuntimeStatus,
  PluginInstanceState,
  PluginScanEvent,
  PluginScanRequest
} from "@yadaw/contracts"

interface PluginRuntime {
  resolveInstance(instanceId: string): Promise<{
    plugin: PluginInstanceState
    sampleRate: number
  }>
  load(
    plugin: PluginInstanceState,
    sampleRate: number
  ): Promise<{
    latencySamples: number
    tailSamples: number | null
  }>
  parameters(instanceId: string): Promise<PluginParameterInfo[]>
  setParameter(change: PluginParameterChange): Promise<void>
  openEditor(instanceId: string): Promise<{ editorMode: PluginEditorMode; open: boolean }>
  closeEditor(instanceId: string): Promise<void>
}

const SCANNER_VERSION = 3
const execFileAsync = promisify(execFile)
const AUDIO_MODES = ["mono", "mono-to-stereo", "stereo", "dual-mono"] as const

function isPluginAudioMode(value: unknown): value is PluginAudioMode {
  return AUDIO_MODES.some((mode) => mode === value)
}

function busesForMode(kind: PluginDescriptor["kind"], mode: PluginAudioMode) {
  const inputChannels = mode === "stereo" || mode === "dual-mono" ? 2 : 1
  const outputChannels = mode === "mono" ? 1 : 2
  const buses: PluginDescriptor["buses"] = []
  if (kind === "effect") {
    buses.push({
      direction: "input",
      kind: "main",
      name: inputChannels === 1 ? "Mono In" : "Stereo In",
      channels: inputChannels,
      defaultActive: true
    })
  }
  buses.push({
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
    id: "dev.yadaw.gain",
    bundleName: "YADAW Gain.vst3",
    classId: "59CABE21E605B9C9EE928D6C3B236BBF",
    name: "YADAW Gain",
    kind: "effect" as const
  },
  {
    id: "dev.yadaw.sine",
    bundleName: "YADAW Sine.vst3",
    classId: "F7BC8CA3E5E8B9C9EE928D7114950FBF",
    name: "YADAW Sine",
    kind: "instrument" as const
  },
  {
    id: "dev.yadaw.metronome",
    bundleName: "YADAW Metronome.vst3",
    classId: "F310A5DEDA34820C9E068A5753F83ADE",
    name: "YADAW Metronome",
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

function descriptorsFromModuleInfo(
  bundlePath: string,
  moduleInfo: Record<string, unknown> | null
): PluginDescriptor[] {
  const factory = record(moduleInfo?.["Factory Info"])
  const classes = Array.isArray(moduleInfo?.["Classes"]) ? moduleInfo["Classes"] : []
  const vendor = textValue(factory?.["Vendor"], "Unknown vendor")
  const fallbackName = basename(bundlePath).replace(/\.vst3$/i, "")
  if (classes.length === 0) {
    return [
      {
        source: { kind: "external" },
        classId: `unprobed:${bundlePath}`,
        modulePath: bundlePath,
        name: fallbackName,
        vendor,
        version: textValue(moduleInfo?.["Version"], ""),
        category: "Audio Module Class",
        kind: "effect",
        architecture: process.arch,
        buses: [],
        supportedAudioModes: [],
        hasEditor: false,
        compatibility: "load-error",
        compatibilityReason: "Native VST3 probing is required for this module"
      }
    ]
  }
  return classes.flatMap((value) => {
    const classInfo = record(value)
    if (!classInfo || textValue(classInfo["Category"]) !== "Audio Module Class") return []
    const subCategories = stringList(classInfo["Sub Categories"])
    const kind = subCategories.some(
      (category) =>
        category.toLowerCase().includes("instrument") || category.toLowerCase().includes("synth")
    )
      ? "instrument"
      : "effect"
    return [
      {
        source: { kind: "external" },
        classId: textValue(classInfo["CID"], `unprobed:${bundlePath}`),
        modulePath: bundlePath,
        name: textValue(classInfo["Name"], fallbackName),
        vendor: textValue(classInfo["Vendor"], vendor),
        version: textValue(classInfo["Version"], textValue(moduleInfo?.["Version"])),
        category: subCategories.join("|") || (kind === "instrument" ? "Instrument" : "Fx"),
        kind,
        architecture: process.arch,
        supportedAudioModes: ["stereo"],
        buses:
          kind === "instrument"
            ? [
                {
                  direction: "output" as const,
                  kind: "main" as const,
                  name: "Stereo Out",
                  channels: 2,
                  defaultActive: true
                }
              ]
            : [
                {
                  direction: "input" as const,
                  kind: "main" as const,
                  name: "Stereo In",
                  channels: 2,
                  defaultActive: true
                },
                {
                  direction: "output" as const,
                  kind: "main" as const,
                  name: "Stereo Out",
                  channels: 2,
                  defaultActive: true
                }
              ],
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
      category?: string
      initialized?: boolean
      sample32?: boolean
      hasEditor?: boolean
      audioInputs?: number
      audioOutputs?: number
      eventInputs?: number
      supportedAudioModes?: unknown[]
    }>
  }
}

/** Recover the probe JSON payload when plug-ins also write diagnostics to stdout. */
export function parseProbeStdout(stdout: string): ProbeOutput {
  const trimmed = stdout.trim()
  try {
    return JSON.parse(trimmed) as ProbeOutput
  } catch {
    // Keep scanning reverse lines for the final JSON object emitted by the probe.
  }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith("{")) continue
    try {
      return JSON.parse(candidate) as ProbeOutput
    } catch {
      // Try earlier lines.
    }
  }
  throw new Error("VST3 probe returned an invalid descriptor")
}

export function descriptorFromProbe(
  bundlePath: string,
  factoryVendor: string,
  value: NonNullable<NonNullable<ProbeOutput["module"]>["classes"]>[number]
): PluginDescriptor | null {
  const classId = textValue(value.classId)
  if (!classId) return null
  const category = textValue(value.category)
  const kind = /instrument|synth/i.test(category) ? "instrument" : "effect"
  const probedModes = (value.supportedAudioModes ?? []).filter(isPluginAudioMode)
  const nativeModes = probedModes.filter((mode) =>
    kind === "instrument" ? mode === "mono" || mode === "stereo" : mode !== "dual-mono"
  )
  const supportedAudioModes: PluginAudioMode[] =
    kind === "effect" && nativeModes.includes("mono") ? [...nativeModes, "dual-mono"] : nativeModes
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
    ((value.audioInputs ?? 0) !== 0 ||
      (value.eventInputs ?? 0) < 1 ||
      (value.audioOutputs ?? 0) !== 1 ||
      supportedAudioModes.length === 0)
  ) {
    compatibility = "unsupported-buses"
    compatibilityReason =
      "Instrument requires event input, no audio input, and a mono or stereo main output"
  } else if (
    kind === "effect" &&
    ((value.audioInputs ?? 0) !== 1 ||
      (value.audioOutputs ?? 0) !== 1 ||
      supportedAudioModes.length === 0)
  ) {
    compatibility = "unsupported-buses"
    compatibilityReason = "Effect requires one supported mono/stereo main input and output layout"
  }
  const preferredMode =
    supportedAudioModes.find((mode) => mode === "stereo") ??
    supportedAudioModes.find((mode) => mode !== "dual-mono") ??
    "stereo"
  return {
    source: { kind: "external" },
    classId,
    modulePath: bundlePath,
    name: textValue(value.name, basename(bundlePath).replace(/\.vst3$/i, "")),
    vendor: textValue(value.vendor, factoryVendor || "Unknown vendor"),
    version: textValue(value.version),
    category: category || (kind === "instrument" ? "Instrument" : "Fx"),
    kind,
    architecture: process.arch,
    buses: busesForMode(kind, preferredMode),
    supportedAudioModes,
    hasEditor: value.hasEditor === true,
    compatibility,
    compatibilityReason
  }
}

export class PluginCatalogService {
  private readonly catalogPath: string
  private catalog: PluginCatalogSnapshot = {
    scannerVersion: SCANNER_VERSION,
    scanning: false,
    scannedAt: null,
    plugins: []
  }
  private readonly listeners = new Set<ScanListener>()
  private fingerprints: Record<string, PluginFingerprint> = {}
  private scanPromise: Promise<PluginCatalogSnapshot> | null = null
  private runtime: PluginRuntime | null = null

  constructor(
    userData: string,
    private readonly probePath: string,
    private readonly builtinDirectory: string
  ) {
    this.catalogPath = join(userData, "plugin-catalog.json")
  }

  attachRuntime(runtime: PluginRuntime): void {
    this.runtime = runtime
  }

  async initialize(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.catalogPath, "utf8")) as StoredCatalog
      if (parsed.scannerVersion === SCANNER_VERSION && Array.isArray(parsed.plugins)) {
        this.catalog = { ...parsed, scanning: false }
        this.fingerprints = parsed.fingerprints ?? {}
      }
    } catch {
      // The catalog is a rebuildable cache.
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
          vendor: descriptor.vendor === "Unknown vendor" ? "YADAW" : descriptor.vendor
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Built-in VST3 probe failed"
        const inputBus = {
          direction: "input" as const,
          kind: "main" as const,
          name: "Stereo In",
          channels: 2,
          defaultActive: true
        }
        const outputBus = {
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
          vendor: "YADAW",
          version: "",
          category: spec.kind === "instrument" ? "Instrument|Synth" : "Fx",
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
    return descriptor ? structuredClone(descriptor) : snapshot
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
    this.scanPromise ??= this.scanNow(request)
      .catch((error: unknown) => {
        this.catalog = { ...this.catalog, scanning: false }
        throw error
      })
      .finally(() => {
        this.scanPromise = null
      })
    return this.scanPromise
  }

  private async scanNow(request: PluginScanRequest): Promise<PluginCatalogSnapshot> {
    // Incremental scans reuse descriptors when mtime/size fingerprints match.
    // Forced scans (manual Rescan) and changed/new/quarantined-retry bundles
    // re-run the isolated yadaw-vst3-probe.
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
        plugins.push(...(await this.probe(bundlePath)))
      } catch (error) {
        const reason = error instanceof Error ? error.message : "VST3 probe failed"
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
    await mkdir(dirname(this.catalogPath), { recursive: true })
    const temporary = `${this.catalogPath}.${process.pid}.tmp`
    await writeFile(
      temporary,
      `${JSON.stringify(
        {
          ...this.catalog,
          fingerprints: this.fingerprints
        },
        null,
        2
      )}\n`,
      "utf8"
    )
    await rename(temporary, this.catalogPath)
    this.publish({ type: "completed", catalog: this.list() })
    return this.list()
  }

  private async probe(bundlePath: string): Promise<PluginDescriptor[]> {
    const { stdout } = await execFileAsync(this.probePath, [bundlePath], {
      // Child-process deep probes reopen slow commercial modules; keep headroom.
      timeout: 60_000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8"
    })
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
    if (!this.runtime) throw new Error("The native VST3 runtime is not running")
    const { plugin, sampleRate } = await this.runtime.resolveInstance(instanceId)
    const status = await this.runtime.load(plugin, sampleRate)
    const editor = await this.runtime.openEditor(instanceId)
    return {
      instanceId,
      state: plugin.enabled ? "active" : "bypassed",
      editorOpen: editor.open,
      editorMode: editor.editorMode,
      latencySamples: status.latencySamples,
      tailSamples: status.tailSamples,
      error: null
    }
  }

  async closeEditor(instanceId: string): Promise<void> {
    await this.runtime?.closeEditor(instanceId)
  }

  parameters(instanceId: string): Promise<PluginParameterInfo[]> {
    if (!this.runtime) return Promise.resolve([])
    return this.runtime.parameters(instanceId)
  }

  async setParameter(change: PluginParameterChange): Promise<void> {
    if (
      !Number.isInteger(change.parameterId) ||
      !Number.isFinite(change.normalized) ||
      change.normalized < 0 ||
      change.normalized > 1
    ) {
      throw new TypeError("Invalid VST3 parameter change")
    }
    if (!this.runtime) throw new Error("The native VST3 runtime is not running")
    await this.runtime.setParameter(change)
  }
}

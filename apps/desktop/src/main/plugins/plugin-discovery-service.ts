import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  normalizePluginDescriptor,
  type PluginCatalogSnapshot,
  type PluginDescriptor,
  type PluginScanEvent,
  type PluginScanRequest
} from "@heron/contracts"
import { PluginCatalogCache } from "./plugin-catalog-cache"
import { descriptorsFromModuleInfo } from "./plugin-descriptor-normalizer"
import type { PluginProbeClient } from "./plugin-probe-client"

export const PLUGIN_SCANNER_VERSION = 8

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

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
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
      if (entry.name.toLowerCase().endsWith(".vst3")) bundles.push(path)
      else if (entry.isDirectory()) pending.push(path)
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

function hasClass(moduleInfo: Record<string, unknown> | null, category: string): boolean {
  return moduleInfoClasses(moduleInfo).some(
    (value) => textValue(record(value)?.["Category"]) === category
  )
}

export class PluginDiscoveryService {
  private readonly cache: PluginCatalogCache
  private fingerprints: Record<string, PluginFingerprint> = {}

  constructor(
    userData: string,
    private readonly probeClient: PluginProbeClient,
    private readonly systemPluginPaths: () => string[] = defaultPluginPaths
  ) {
    this.cache = new PluginCatalogCache(join(userData, "plugin-catalog.json"))
  }

  async loadCachedCatalog(): Promise<PluginCatalogSnapshot | null> {
    const parsed = await this.cache.load<StoredCatalog>()
    if (parsed?.scannerVersion !== PLUGIN_SCANNER_VERSION || !Array.isArray(parsed.plugins)) {
      return null
    }
    this.fingerprints = parsed.fingerprints ?? {}
    return {
      ...parsed,
      scanning: false,
      plugins: parsed.plugins.map((plugin) => normalizePluginDescriptor(plugin))
    }
  }

  async scan(
    catalog: PluginCatalogSnapshot,
    request: PluginScanRequest,
    publish: (event: PluginScanEvent) => void
  ): Promise<PluginCatalogSnapshot> {
    const knownExternalRoots = catalog.plugins
      .filter((plugin) => plugin.source.kind === "external")
      .map((plugin) => dirname(plugin.modulePath))
    const roots = [
      ...new Set([...(request.paths ?? []), ...knownExternalRoots, ...this.systemPluginPaths()])
    ]
    const bundles = (await Promise.all(roots.map(discoverBundles))).flat()
    publish({ type: "started", total: bundles.length })
    const plugins: PluginDescriptor[] = []
    const fingerprints: Record<string, PluginFingerprint> = {}
    for (const [index, bundlePath] of bundles.entries()) {
      publish({ type: "progress", completed: index, total: bundles.length, path: bundlePath })
      try {
        const bundleStat = await stat(bundlePath)
        const fingerprint = { mtimeMs: bundleStat.mtimeMs, size: bundleStat.size }
        fingerprints[bundlePath] = fingerprint
        const previousFingerprint = this.fingerprints[bundlePath]
        const previousPlugins = catalog.plugins.filter((plugin) => plugin.modulePath === bundlePath)
        if (
          canReuseCachedBundle({
            force: request.force === true,
            retryQuarantined: request.retryQuarantined === true,
            fingerprintMatches:
              previousFingerprint?.mtimeMs === fingerprint.mtimeMs &&
              previousFingerprint.size === fingerprint.size,
            previousPlugins
          })
        ) {
          plugins.push(...previousPlugins)
          continue
        }
        plugins.push(...(await this.discoverBundle(bundlePath)))
      } catch (error) {
        const reason = error instanceof Error ? error.message : "VST3 discovery failed"
        publish({ type: "quarantined", path: bundlePath, reason })
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

    const builtins = catalog.plugins.filter((plugin) => plugin.source.kind === "builtin")
    const builtinClassIds = new Set(builtins.map((plugin) => plugin.classId))
    const unique = new Map<string, PluginDescriptor>(
      builtins.map((plugin) => [plugin.classId, plugin])
    )
    for (const plugin of plugins) {
      if (!builtinClassIds.has(plugin.classId) && !unique.has(plugin.classId)) {
        unique.set(plugin.classId, plugin)
      }
    }
    const next: PluginCatalogSnapshot = {
      scannerVersion: PLUGIN_SCANNER_VERSION,
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
    await this.cache.store({ ...next, fingerprints })
    return next
  }

  private async discoverBundle(bundlePath: string): Promise<PluginDescriptor[]> {
    const moduleInfo = await readModuleInfo(bundlePath)
    if (
      hasClass(moduleInfo, "Audio Module Class") &&
      !hasClass(moduleInfo, "ARA Main Factory Class")
    ) {
      return descriptorsFromModuleInfo(bundlePath, moduleInfo)
    }
    return this.probeClient.probe(bundlePath, "soft")
  }
}

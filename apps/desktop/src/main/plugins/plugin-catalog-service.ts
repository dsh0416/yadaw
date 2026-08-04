import { join } from "node:path"
import {
  defaultPluginCategories,
  normalizePluginDescriptor,
  type PluginCatalogSnapshot,
  type PluginDescriptor,
  type PluginParameterChange,
  type PluginParameterInfo,
  type PluginRuntimeStatus,
  type PluginScanEvent,
  type PluginScanRequest
} from "@heron/contracts"
import { PluginDiscoveryService, PLUGIN_SCANNER_VERSION } from "./plugin-discovery-service"
import { PluginProbeClient } from "./plugin-probe-client"
import { PluginRuntimeService, type PluginRuntime } from "./plugin-runtime-service"
import { PluginScanner } from "./plugin-scanner"

export { canReuseCachedBundle } from "./plugin-discovery-service"
export { descriptorFromProbe, descriptorsFromModuleInfo } from "./plugin-descriptor-normalizer"
export { parseProbeStdout } from "./plugin-descriptor-decoder"

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

export interface PluginCatalogDependencies {
  probeClient?: PluginProbeClient
  discovery?: PluginDiscoveryService
}

export class PluginCatalogService {
  private catalog: PluginCatalogSnapshot = {
    scannerVersion: PLUGIN_SCANNER_VERSION,
    scanning: false,
    scannedAt: null,
    plugins: []
  }
  private readonly listeners = new Set<ScanListener>()
  private readonly scanner = new PluginScanner<PluginScanRequest, PluginCatalogSnapshot>()
  private readonly runtime = new PluginRuntimeService()
  private readonly runtimeBundleProbes = new Map<string, Promise<PluginDescriptor[]>>()
  private readonly probeClient: PluginProbeClient
  private readonly discovery: PluginDiscoveryService

  constructor(
    userData: string,
    probePath: string,
    private readonly builtinDirectory: string,
    dependencies: PluginCatalogDependencies = {}
  ) {
    this.probeClient = dependencies.probeClient ?? new PluginProbeClient(probePath)
    this.discovery =
      dependencies.discovery ?? new PluginDiscoveryService(userData, this.probeClient)
  }

  attachRuntime(runtime: PluginRuntime): void {
    this.runtime.attach(runtime)
  }

  async initialize(): Promise<void> {
    this.catalog = (await this.discovery.loadCachedCatalog()) ?? this.catalog
    await this.refreshBuiltins()
  }

  private async refreshBuiltins(): Promise<void> {
    const external = this.catalog.plugins.filter((plugin) => plugin.source.kind === "external")
    const builtins: PluginDescriptor[] = []
    for (const spec of BUILTIN_PLUGINS) {
      const modulePath = join(this.builtinDirectory, spec.bundleName)
      try {
        const descriptors = await this.probeClient.probe(modulePath)
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
      pending = this.probeClient.probe(resolved.modulePath, "deep")
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
      this.runtimeBundleProbes.delete(resolved.modulePath)
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
    return this.scanner.run(request, async (value) => {
      this.catalog = { ...this.catalog, scanning: true }
      try {
        this.catalog = await this.discovery.scan(this.catalog, value, (event) =>
          this.publish(event)
        )
        this.publish({ type: "completed", catalog: this.list() })
        return this.list()
      } catch (error) {
        this.catalog = { ...this.catalog, scanning: false }
        throw error
      }
    })
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

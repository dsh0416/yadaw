import { join } from "node:path"
import {
  defaultPluginCategories,
  normalizePluginDescriptor,
  pluginLocator,
  pluginTypeKey,
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
        const descriptor = descriptors.find(
          (candidate) => pluginLocator(candidate).nativeId === spec.classId
        )
        if (!descriptor) throw new Error(`Built-in Class ID changed; expected ${spec.classId}`)
        builtins.push({
          ...descriptor,
          source: { kind: "builtin", id: spec.id },
          vendor: descriptor.vendor === "Unknown vendor" ? "Heron Studio" : descriptor.vendor
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Built-in VST3 probe failed"
        const inputBus = {
          portKey: "vst3:audio:input:0",
          direction: "input" as const,
          kind: "main" as const,
          name: "Stereo In",
          channels: 2,
          defaultActive: true
        }
        const outputBus = {
          portKey: "vst3:audio:output:0",
          direction: "output" as const,
          kind: "main" as const,
          name: "Stereo Out",
          channels: 2,
          defaultActive: true
        }
        builtins.push({
          source: { kind: "builtin", id: spec.id },
          locator: { format: "vst3", artifactPath: modulePath, nativeId: spec.classId },
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
    const builtinTypeKeys = new Set(builtins.map(pluginTypeKey))
    this.catalog = {
      ...this.catalog,
      plugins: [
        ...builtins,
        ...external.filter((plugin) => !builtinTypeKeys.has(pluginTypeKey(plugin)))
      ]
    }
  }

  resolveDescriptor(snapshot: PluginDescriptor): PluginDescriptor {
    const descriptor = this.catalog.plugins.find((candidate) => {
      const candidateLocator = pluginLocator(candidate)
      const snapshotLocator = pluginLocator(snapshot)
      if (snapshot.source.kind === "builtin") {
        return (
          candidate.source.kind === "builtin" &&
          candidate.source.id === snapshot.source.id &&
          pluginTypeKey(candidateLocator) === pluginTypeKey(snapshotLocator)
        )
      }
      return (
        candidate.source.kind === "external" &&
        candidateLocator.format === snapshotLocator.format &&
        candidateLocator.nativeId === snapshotLocator.nativeId &&
        candidateLocator.artifactPath === snapshotLocator.artifactPath
      )
    })
    return normalizePluginDescriptor(descriptor ? structuredClone(descriptor) : snapshot)
  }

  async resolveDescriptorForRuntime(snapshot: PluginDescriptor): Promise<PluginDescriptor> {
    const resolved = this.resolveDescriptor(snapshot)
    if (resolved.source.kind === "builtin") return resolved
    const locator = pluginLocator(resolved)
    let pending = this.runtimeBundleProbes.get(locator.artifactPath)
    if (!pending) {
      pending = this.probeClient.probe(locator.artifactPath, "deep")
      this.runtimeBundleProbes.set(locator.artifactPath, pending)
    }
    try {
      const descriptors = await pending
      const byNativeId = new Map(
        descriptors.map((descriptor) => [pluginLocator(descriptor).nativeId, descriptor])
      )
      this.catalog = {
        ...this.catalog,
        plugins: this.catalog.plugins.map((descriptor) =>
          descriptor.source.kind === "external" &&
          pluginLocator(descriptor).artifactPath === locator.artifactPath
            ? (byNativeId.get(pluginLocator(descriptor).nativeId) ?? descriptor)
            : descriptor
        )
      }
      const descriptor = descriptors.find(
        (descriptor) => pluginLocator(descriptor).nativeId === locator.nativeId
      )
      if (descriptor) return structuredClone(descriptor)
      return this.markRuntimeProbeUnavailable(
        resolved,
        "Deep probe did not return the requested plug-in class"
      )
    } catch (error) {
      this.runtimeBundleProbes.delete(locator.artifactPath)
      return this.markRuntimeProbeUnavailable(
        resolved,
        error instanceof Error ? error.message : "Deep plug-in capability probe failed"
      )
    }
  }

  private markRuntimeProbeUnavailable(
    descriptor: PluginDescriptor,
    reason: string
  ): PluginDescriptor {
    const unavailable: PluginDescriptor = {
      ...descriptor,
      supportedAudioModes: [],
      compatibility: "load-error",
      compatibilityReason: reason
    }
    const unavailableLocator = pluginLocator(unavailable)
    this.catalog = {
      ...this.catalog,
      plugins: this.catalog.plugins.map((candidate) => {
        const candidateLocator = pluginLocator(candidate)
        return candidate.source.kind === "external" &&
          candidateLocator.format === unavailableLocator.format &&
          candidateLocator.artifactPath === unavailableLocator.artifactPath &&
          candidateLocator.nativeId === unavailableLocator.nativeId
          ? unavailable
          : candidate
      })
    }
    return structuredClone(unavailable)
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

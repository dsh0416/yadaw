import { randomUUID } from "node:crypto"
import { pluginLocator, rpcFailure, rpcSuccess } from "@heron/contracts"
import type {
  ProjectGraphRef,
  ProjectGraphSnapshot,
  RpcRequestMeta,
  RpcResult
} from "@heron/contracts"
import { cloneGraph, validateGraph } from "@heron/project-model"
import { AssetMaterializer } from "./asset-materializer"
import type { ProjectAssetReader } from "./asset-materializer"
import { AudioGraphCompiler } from "./audio-graph-compiler"
import type { RuntimeLatencyPolicy } from "./audio-graph-compiler"
import type { AudioHostService } from "../audio-host"
import type { PreparedGraphDeployment } from "../audio-host"
import type { ApplicationSettingsStore } from "../settings"
import type { PluginCatalogService } from "../plugins"

export interface PreparedProjectGraph {
  graph: ProjectGraphSnapshot
  revision: number
  native: PreparedGraphDeployment | null
}

export interface GraphPublicationOptions {
  softwareMonitoringOverride?: boolean
  latencyPolicy?: RuntimeLatencyPolicy
  awaitPublication?: boolean
}

export class AudioGraphPublisher {
  private revision = 0

  constructor(
    private readonly compiler: AudioGraphCompiler,
    private readonly assets: AssetMaterializer,
    private readonly audioHost: AudioHostService | null,
    private readonly plugins: PluginCatalogService | null,
    private readonly settings: ApplicationSettingsStore | null
  ) {}

  resolve(graph: ProjectGraphSnapshot): ProjectGraphSnapshot {
    const resolved = cloneGraph(graph)
    resolved.plugins = resolved.plugins.map((plugin) => {
      const descriptor = this.plugins?.resolveDescriptor(plugin.descriptor) ?? plugin.descriptor
      return {
        ...plugin,
        locator: { ...pluginLocator(descriptor) },
        descriptor
      }
    })
    return resolved
  }

  private async resolveForRuntime(graph: ProjectGraphSnapshot): Promise<ProjectGraphSnapshot> {
    const resolved = cloneGraph(graph)
    const plugins = this.plugins
    if (!plugins) return resolved
    resolved.plugins = await Promise.all(
      resolved.plugins.map(async (plugin) => {
        const descriptor = await plugins.resolveDescriptorForRuntime(plugin.descriptor)
        return {
          ...plugin,
          locator: { ...pluginLocator(descriptor) },
          descriptor
        }
      })
    )
    return resolved
  }

  async prepare(
    meta: RpcRequestMeta,
    projectGraph: ProjectGraphRef,
    source: ProjectGraphSnapshot,
    assetSource?: ProjectAssetReader,
    options: GraphPublicationOptions = {}
  ): Promise<RpcResult<PreparedProjectGraph>> {
    const graph = await this.resolveForRuntime(source)
    validateGraph(graph)
    const softwareMonitoringEnabled =
      (await this.settings?.get())?.softwareMonitoringEnabled ?? false
    const paths = await this.assets.materialize(graph, assetSource)
    const runtimeGraph = this.compiler.compile(graph, paths, {
      softwareMonitoringEnabled,
      latencyPolicy: options.latencyPolicy ?? { type: "normal" }
    })
    this.revision += 1
    if (!this.audioHost) {
      return rpcSuccess(
        meta,
        { graph, revision: this.revision, native: null },
        { resourceRevision: this.revision }
      )
    }
    const prepared = await this.audioHost.prepareGraphDeployment(
      meta,
      projectGraph,
      this.revision,
      graph,
      runtimeGraph
    )
    if (!prepared.ok) return prepared
    return rpcSuccess(
      meta,
      { graph, revision: this.revision, native: prepared.value },
      { resourceRevision: this.revision }
    )
  }

  async activate(
    meta: RpcRequestMeta,
    prepared: PreparedProjectGraph
  ): Promise<RpcResult<ProjectGraphSnapshot>> {
    if (prepared.native) {
      if (!this.audioHost) {
        return rpcFailure(meta, {
          code: "resource-unavailable",
          category: "unavailable",
          outcome: "not-committed",
          retry: "safe",
          correlationId: randomUUID(),
          userMessageKey: "errors.audioEngineUnavailable",
          resource: prepared.native.projectGraph,
          details: {
            type: "resource-unavailable",
            component: "audio-host",
            dispatched: false
          }
        })
      }
      try {
        const activated = await this.audioHost.activateGraphDeployment(prepared.native)
        if (!activated.ok) return activated
      } catch {
        return rpcFailure(meta, {
          code: "resource-unavailable",
          category: "unavailable",
          outcome: "not-committed",
          retry: "safe",
          correlationId: randomUUID(),
          userMessageKey: "errors.audioEngineUnavailable",
          resource: prepared.native.projectGraph,
          details: {
            type: "resource-unavailable",
            component: "audio-host",
            dispatched: true
          }
        })
      }
    }
    return rpcSuccess(meta, cloneGraph(prepared.graph), {
      resourceRevision: prepared.revision
    })
  }

  async abort(prepared: PreparedProjectGraph): Promise<void> {
    if (!prepared.native || !this.audioHost) return
    await this.audioHost.abortGraphDeployment(prepared.native)
  }

  async publish(
    source: ProjectGraphSnapshot,
    input: GraphPublicationOptions | boolean = {},
    legacyAwaitPublication = false
  ): Promise<ProjectGraphSnapshot> {
    const options: GraphPublicationOptions =
      typeof input === "boolean"
        ? { softwareMonitoringOverride: input, awaitPublication: legacyAwaitPublication }
        : input
    const graph = await this.resolveForRuntime(source)
    validateGraph(graph)
    const softwareMonitoringEnabled =
      options.softwareMonitoringOverride ??
      (await this.settings?.get())?.softwareMonitoringEnabled ??
      false
    const paths = await this.assets.materialize(graph)
    const runtimeGraph = this.compiler.compile(graph, paths, {
      softwareMonitoringEnabled,
      latencyPolicy: options.latencyPolicy ?? { type: "normal" }
    })
    this.revision += 1
    await this.audioHost?.loadGraph(
      this.revision,
      graph,
      runtimeGraph,
      options.awaitPublication ?? false
    )
    return graph
  }

  compiledAudioGraphSnapshot() {
    return this.audioHost?.compiledAudioGraphSnapshot() ?? Promise.resolve(null)
  }

  async lowLatencyPluginBudgetMs(): Promise<number> {
    return (await this.settings?.get())?.lowLatencyPluginBudgetMs ?? 5
  }

  async setLowLatencyPluginBudgetMs(value: number): Promise<void> {
    await this.settings?.setLowLatencyPluginBudgetMs(value)
  }
}

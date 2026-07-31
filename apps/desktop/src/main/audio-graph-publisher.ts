import { rpcSuccess } from "@yadaw/contracts"
import type {
  ProjectGraphRef,
  ProjectGraphSnapshot,
  RpcRequestMeta,
  RpcResult
} from "@yadaw/contracts"
import { cloneGraph, validateGraph } from "@yadaw/project-model"
import { AssetMaterializer } from "./asset-materializer"
import type { ProjectAssetReader } from "./asset-materializer"
import { AudioGraphCompiler } from "./audio-graph-compiler"
import type { AudioHostService } from "./audio-host-service"
import type { PreparedGraphDeployment } from "./audio-host-graph-transactions"
import type { ApplicationSettingsStore } from "./application-settings"
import type { PluginCatalogService } from "./plugin-catalog-service"

export interface PreparedProjectGraph {
  graph: ProjectGraphSnapshot
  revision: number
  native: PreparedGraphDeployment | null
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
    resolved.plugins = resolved.plugins.map((plugin) => ({
      ...plugin,
      descriptor: this.plugins?.resolveDescriptor(plugin.descriptor) ?? plugin.descriptor
    }))
    return resolved
  }

  async prepare(
    meta: RpcRequestMeta,
    projectGraph: ProjectGraphRef,
    source: ProjectGraphSnapshot,
    assetSource?: ProjectAssetReader
  ): Promise<RpcResult<PreparedProjectGraph>> {
    const graph = this.resolve(source)
    validateGraph(graph)
    const softwareMonitoringEnabled =
      (await this.settings?.get())?.softwareMonitoringEnabled ?? false
    const paths = await this.assets.materialize(graph, assetSource)
    const runtimeGraph = this.compiler.compile(graph, paths, softwareMonitoringEnabled)
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
      const activated = await this.audioHost?.activateGraphDeployment(prepared.native)
      if (activated && !activated.ok) return activated
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
    softwareMonitoringOverride?: boolean,
    awaitPublication = false
  ): Promise<ProjectGraphSnapshot> {
    const graph = this.resolve(source)
    validateGraph(graph)
    const softwareMonitoringEnabled =
      softwareMonitoringOverride ?? (await this.settings?.get())?.softwareMonitoringEnabled ?? false
    const paths = await this.assets.materialize(graph)
    const runtimeGraph = this.compiler.compile(graph, paths, softwareMonitoringEnabled)
    this.revision += 1
    await this.audioHost?.loadGraph(this.revision, graph, runtimeGraph, awaitPublication)
    return graph
  }
}

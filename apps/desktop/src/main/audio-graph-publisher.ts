import type { ProjectGraphSnapshot } from "@yadaw/contracts"
import { cloneGraph, validateGraph } from "@yadaw/project-model"
import { AssetMaterializer } from "./asset-materializer"
import { AudioGraphCompiler } from "./audio-graph-compiler"
import type { AudioHostService } from "./audio-host-service"
import type { ApplicationSettingsStore } from "./application-settings"
import type { PluginCatalogService } from "./plugin-catalog-service"

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

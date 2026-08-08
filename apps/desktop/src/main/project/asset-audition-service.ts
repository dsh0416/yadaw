import type { AudioHostService } from "../audio-host"
import type { AssetMaterializer } from "./asset-materializer"
import type { ProjectGraphService } from "./project-graph-service"
import type { ProjectService } from "./project-service"

export class AssetAuditionService {
  constructor(
    private readonly projects: ProjectService,
    private readonly graphs: ProjectGraphService,
    private readonly materializer: AssetMaterializer,
    private readonly audioHost: AudioHostService
  ) {}

  async start(assetId: string): Promise<void> {
    const asset = (await this.projects.listAssets()).find((candidate) => candidate.id === assetId)
    if (!asset || asset.kind !== "audio") throw new Error("Audio asset was not found")
    const graph = await this.graphs.snapshot()
    const output = graph.channels.find(
      (channel) => channel.kind === "output" && channel.hardwareOutputChannels.length === 2
    )
    if (!output) throw new Error("Project has no monitored stereo Output")
    const path = await this.materializer.materializeAsset(assetId)
    await this.audioHost.startAssetAudition(path, [
      output.hardwareOutputChannels[0]!,
      output.hardwareOutputChannels[1]!
    ])
  }

  stop(): Promise<void> {
    return this.audioHost.stopAssetAudition()
  }
}

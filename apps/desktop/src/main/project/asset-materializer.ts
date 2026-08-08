import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProjectGraphSnapshot } from "@heron/contracts"
import type { AssetContentHash } from "@heron/project-db/protocol"
import type { ProjectService } from "./project-service"

export interface ProjectAssetReader {
  assetContentHashes(ids: string[]): Promise<AssetContentHash[]>
  readAssetAudio(assetId: string): Promise<Uint8Array>
}

export class AssetMaterializer {
  private readonly cacheDirectory: string

  constructor(
    userData: string,
    private readonly projects: ProjectService
  ) {
    this.cacheDirectory = join(userData, "mixer-cache")
  }

  async materialize(
    graph: ProjectGraphSnapshot,
    source: ProjectAssetReader = this.projects
  ): Promise<Map<string, string>> {
    const ids = [...new Set(graph.audioClips.map((clip) => clip.assetId))]
    return this.materializeIds(ids, source)
  }

  async materializeAsset(
    assetId: string,
    source: ProjectAssetReader = this.projects
  ): Promise<string> {
    const paths = await this.materializeIds([assetId], source)
    const path = paths.get(assetId)
    if (!path) throw new Error(`Audio asset '${assetId}' could not be materialized`)
    return path
  }

  private async materializeIds(
    ids: readonly string[],
    source: ProjectAssetReader
  ): Promise<Map<string, string>> {
    await mkdir(this.cacheDirectory, { recursive: true })
    const contentHashes = new Map(
      (await source.assetContentHashes([...ids])).map((asset) => [asset.id, asset.contentHash])
    )
    const result = new Map<string, string>()
    for (const id of ids) {
      const contentHash = contentHashes.get(id) ?? "unknown"
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_")
      const path = join(this.cacheDirectory, `${safeId}-${contentHash}.bwf`)
      try {
        await access(path)
      } catch {
        const temporary = `${path}.${process.pid}.tmp`
        try {
          await writeFile(temporary, await source.readAssetAudio(id))
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      result.set(id, path)
    }
    return result
  }
}

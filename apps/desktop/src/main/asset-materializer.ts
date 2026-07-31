import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProjectGraphSnapshot } from "@yadaw/contracts"
import type { ProjectService } from "./project-service"

export class AssetMaterializer {
  private readonly cacheDirectory: string

  constructor(
    userData: string,
    private readonly projects: ProjectService
  ) {
    this.cacheDirectory = join(userData, "mixer-cache")
  }

  async materialize(graph: ProjectGraphSnapshot): Promise<Map<string, string>> {
    await mkdir(this.cacheDirectory, { recursive: true })
    const ids = [...new Set(graph.audioClips.map((clip) => clip.assetId))]
    const contentHashes = new Map(
      (await this.projects.assetContentHashes(ids)).map((asset) => [asset.id, asset.contentHash])
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
          await writeFile(temporary, await this.projects.readAssetAudio(id))
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

import { describe, expect, it, vi } from "vitest"
import type {
  ProjectAssetSummary,
  ProjectAudioAssetSummary,
  ProjectGraphSnapshot
} from "@heron/contracts"
import type { AudioHostService } from "../audio-host"
import type { AssetMaterializer } from "./asset-materializer"
import { AssetAuditionService } from "./asset-audition-service"
import type { ProjectGraphService } from "./project-graph-service"
import type { ProjectService } from "./project-service"

const asset: ProjectAudioAssetSummary = {
  id: "asset-1",
  kind: "audio",
  name: "Audio.wav",
  contentHash: "hash-1",
  sampleRate: 48_000,
  channels: 2,
  bitDepth: "float32",
  frameCount: 48_000n
}

function harness(graphOverrides: Partial<ProjectGraphSnapshot> = {}) {
  const projects = { listAssets: vi.fn<() => Promise<ProjectAssetSummary[]>>(async () => [asset]) }
  const graphs = {
    snapshot: vi.fn(async () => ({
      channels: [
        { kind: "output", hardwareOutputChannels: [3, 4] },
        { kind: "output", hardwareOutputChannels: [5, 6] }
      ],
      ...graphOverrides
    }))
  }
  const materializer = { materializeAsset: vi.fn(async () => "/cache/asset-1.bwf") }
  const audioHost = {
    startAssetAudition: vi.fn(async () => undefined),
    stopAssetAudition: vi.fn(async () => undefined)
  }
  return {
    projects,
    graphs,
    materializer,
    audioHost,
    service: new AssetAuditionService(
      projects as unknown as ProjectService,
      graphs as unknown as ProjectGraphService,
      materializer as unknown as AssetMaterializer,
      audioHost as unknown as AudioHostService
    )
  }
}

describe("AssetAuditionService", () => {
  it("materializes one audio asset and routes it to the first stereo Output", async () => {
    const { service, materializer, audioHost } = harness()

    await service.start(asset.id)

    expect(materializer.materializeAsset).toHaveBeenCalledWith(asset.id)
    expect(audioHost.startAssetAudition).toHaveBeenCalledWith("/cache/asset-1.bwf", [3, 4])
  })

  it("rejects non-audio assets and projects without a stereo Output", async () => {
    const missing = harness({ channels: [] })
    await expect(missing.service.start(asset.id)).rejects.toThrow("stereo Output")

    const midi = harness()
    midi.projects.listAssets.mockResolvedValue([
      { id: "midi-1", kind: "midi", name: "Part.mid", contentHash: "midi", byteLength: 12 }
    ])
    await expect(midi.service.start("midi-1")).rejects.toThrow("Audio asset")
  })

  it("stops audition without touching transport state", async () => {
    const { service, audioHost } = harness()

    await service.stop()

    expect(audioHost.stopAssetAudition).toHaveBeenCalledOnce()
  })
})

import { mkdtemp, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { RecordingService } from "./recording-service"

describe("RecordingService archive cleanup", () => {
  it("cleans a ready sidecar after the saved database proves its asset exists", async () => {
    const swapDirectory = await mkdtemp(join(tmpdir(), "heron-recording-cleanup-"))
    const projectPath = join(swapDirectory, "project.heron")
    const id = "recording-id"
    const audioPath = join(swapDirectory, `${id}.ready.bwf`)
    const finalPath = join(swapDirectory, `${id}.final-float32.bwf`)
    const sidecarPath = join(swapDirectory, `${id}.recording.json`)
    await Promise.all([
      writeFile(audioPath, "swap"),
      writeFile(finalPath, "final"),
      writeFile(
        sidecarPath,
        JSON.stringify({
          id,
          state: "ready",
          audioPath,
          sidecarPath,
          projectPath,
          sampleRate: 48_000,
          channels: 2,
          startedAt: Date.now(),
          dropoutFrames: 0,
          assetExists: false,
          finalPath,
          bitDepth: "float32",
          frameCount: 4_800,
          contentHash: "hash"
        })
      )
    ])

    const settings = { get: vi.fn().mockResolvedValue({ swapDirectory }) }
    const projects = {
      current: { path: projectPath },
      assetContentHashes: vi.fn().mockResolvedValue([{ id, contentHash: "hash" }])
    }
    const service = new RecordingService(
      settings as never,
      projects as never,
      {} as never,
      {} as never,
      {} as never
    )
    await service.cleanupCommittedForProject(projectPath)

    await expect(stat(audioPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(finalPath)).rejects.toMatchObject({ code: "ENOENT" })
    await expect(stat(sidecarPath)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("treats recovery as idempotent when the working database already has the asset", async () => {
    const swapDirectory = await mkdtemp(join(tmpdir(), "heron-recording-recover-"))
    const projectPath = join(swapDirectory, "project.heron")
    const id = "already-imported"
    const sidecarPath = join(swapDirectory, `${id}.recording.json`)
    await writeFile(
      sidecarPath,
      JSON.stringify({
        id,
        state: "ready",
        audioPath: join(swapDirectory, `${id}.ready.bwf`),
        sidecarPath,
        projectPath,
        sampleRate: 48_000,
        channels: 2,
        startedAt: Date.now(),
        dropoutFrames: 0,
        assetExists: false,
        finalPath: join(swapDirectory, `${id}.final-float32.bwf`),
        bitDepth: "float32",
        frameCount: 4_800,
        contentHash: "existing-hash"
      })
    )
    const settings = { get: vi.fn().mockResolvedValue({ swapDirectory }) }
    const projects = {
      current: { path: projectPath },
      assetContentHashes: vi.fn().mockResolvedValue([
        {
          id,
          contentHash: "existing-hash"
        }
      ]),
      importLargeObject: vi.fn()
    }
    const operations = { upsert: vi.fn(), patch: vi.fn() }
    const service = new RecordingService(
      settings as never,
      projects as never,
      operations as never,
      {} as never,
      {} as never
    )

    const recovered = await service.recover(id)

    expect(projects.assetContentHashes).toHaveBeenCalledOnce()
    expect(projects.importLargeObject).not.toHaveBeenCalled()
    expect(operations.upsert).not.toHaveBeenCalled()
    expect(recovered).toMatchObject({ id, state: "committed", assetExists: true })
  })
})

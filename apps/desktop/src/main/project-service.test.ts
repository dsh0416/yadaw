import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApplicationSettingsStore } from "./application-settings"
import { ProjectService } from "./project-service"

const dump = vi.fn(async (outputPath: string) => {
  await writeFile(outputPath, "yadaw-archive")
})
const openProject = vi.fn().mockResolvedValue(undefined)

vi.mock("./project-worker-client", () => ({
  ProjectWorkerClient: class {
    create = vi.fn().mockResolvedValue(undefined)
    open = openProject
    dump = dump
    close = vi.fn().mockResolvedValue(undefined)
    terminate = vi.fn().mockResolvedValue(undefined)
    onProgress = null
  }
}))

describe("ProjectService.create", () => {
  let service: ProjectService | null = null

  afterEach(async () => {
    await service?.shutdown()
    service = null
    dump.mockClear()
    openProject.mockReset().mockResolvedValue(undefined)
  })

  it("writes the initial .yadaw archive and returns a clean session", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-project-create-"))
    const projectPath = join(userData, "Untitled.yadaw")
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))

    const session = await service.create({
      path: projectPath,
      name: "Untitled",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })

    await access(projectPath)
    expect(dump).toHaveBeenCalledOnce()
    expect(session).toMatchObject({
      path: projectPath,
      dirty: false,
      recoveredWorkingCopy: false,
      configuration: { name: "Untitled", sampleRate: 48_000 }
    })
    expect(service.current).toMatchObject({ path: projectPath, dirty: false })
  })

  it("leaves the source archive byte-for-byte untouched when migration fails", async () => {
    const userData = await mkdtemp(join(tmpdir(), "yadaw-project-open-failure-"))
    const projectPath = join(userData, "Existing.yadaw")
    const contents = new Uint8Array([0x59, 0x41, 0x44, 0x41, 0x57])
    await writeFile(projectPath, contents)
    const before = await stat(projectPath)
    openProject.mockRejectedValueOnce(new Error("migration failed"))
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))

    await expect(service.open(projectPath, false)).rejects.toThrow("migration failed")

    expect([...(await readFile(projectPath))]).toEqual([...contents])
    expect((await stat(projectPath)).mtimeMs).toBe(before.mtimeMs)
  })
})

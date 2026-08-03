import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApplicationSettingsStore } from "./application-settings"
import { ProjectService } from "./project-service"

const dump = vi.fn(async (outputPath: string) => {
  await writeFile(outputPath, "heron-archive")
})
const openProject = vi.fn().mockResolvedValue(undefined)
const terminatedWorkers: Array<ReturnType<typeof vi.fn>> = []

vi.mock("./project-worker-client", () => ({
  ProjectWorkerClient: class {
    terminate = vi.fn().mockResolvedValue(undefined)
    create = vi.fn().mockResolvedValue(undefined)
    open = openProject
    getConfiguration = vi.fn().mockResolvedValue({
      name: "Recovered",
      sampleRate: 48_000,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      waveformDisplayMode: "separate"
    })
    dump = dump
    close = vi.fn().mockResolvedValue(undefined)
    onProgress = null

    constructor() {
      terminatedWorkers.push(this.terminate)
    }
  }
}))

describe("ProjectService.create", () => {
  let service: ProjectService | null = null

  afterEach(async () => {
    await service?.shutdown()
    service = null
    dump.mockClear()
    openProject.mockReset().mockResolvedValue(undefined)
    terminatedWorkers.length = 0
  })

  it("writes the initial .yadaw archive and returns a clean session", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-create-"))
    const projectPath = join(userData, "Untitled.yadaw")
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))
    const progress = vi.fn()

    const session = await service.create(
      {
        path: projectPath,
        name: "Untitled",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      progress
    )

    await access(projectPath)
    expect(dump).toHaveBeenCalledOnce()
    expect(session).toMatchObject({
      path: projectPath,
      dirty: false,
      recoveredWorkingCopy: false,
      configuration: { name: "Untitled", sampleRate: 48_000 }
    })
    expect(service.current).toMatchObject({ path: projectPath, dirty: false })
    expect(progress.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      { phase: "committing-database", completedUnits: 0 },
      { phase: "saving-archive", completedUnits: 1 }
    ])
  })

  it("leaves the source archive byte-for-byte untouched when migration fails", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-open-failure-"))
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

  it("discards a failed candidate worker before a later healthy open", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-project-worker-recovery-"))
    const brokenPath = join(userData, "Broken.yadaw")
    const healthyPath = join(userData, "Healthy.yadaw")
    await writeFile(brokenPath, "broken")
    await writeFile(healthyPath, "healthy")
    openProject.mockRejectedValueOnce(new Error("database migration failed"))
    service = new ProjectService(userData, new ApplicationSettingsStore(userData))

    await expect(service.open(brokenPath, false)).rejects.toThrow("database migration failed")
    expect(service.current).toBeNull()
    expect(terminatedWorkers[0]).toHaveBeenCalledOnce()

    const progress = vi.fn()
    await expect(service.open(healthyPath, false, progress)).resolves.toMatchObject({
      path: healthyPath,
      configuration: { name: "Recovered" }
    })
    expect(service.current?.path).toBe(healthyPath)
    expect(terminatedWorkers).toHaveLength(2)
    expect(terminatedWorkers[1]).not.toHaveBeenCalled()
    expect(progress.mock.calls.map(([snapshot]) => snapshot)).toEqual([
      { phase: "loading-project-archive", completedUnits: 0 },
      { phase: "restoring-project-state", completedUnits: 1 },
      { phase: "restoring-project-state", completedUnits: 2 }
    ])
  })
})

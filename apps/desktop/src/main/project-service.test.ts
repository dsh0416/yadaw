import { access, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApplicationSettingsStore } from "./application-settings"
import { ProjectService } from "./project-service"

const dump = vi.fn(async (outputPath: string) => {
  await writeFile(outputPath, "yadaw-archive")
})

vi.mock("./project-worker-client", () => ({
  ProjectWorkerClient: class {
    create = vi.fn().mockResolvedValue(undefined)
    open = vi.fn().mockResolvedValue(undefined)
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
})

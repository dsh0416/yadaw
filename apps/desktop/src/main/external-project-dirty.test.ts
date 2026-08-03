import { describe, expect, it, vi } from "vitest"
import type { ProjectSession } from "@heron/contracts"
import { commitExternalProjectDirty } from "./external-project-dirty"

const cleanProject: ProjectSession = {
  id: "project",
  path: "project.heron",
  configuration: {
    name: "Project",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

describe("commitExternalProjectDirty", () => {
  it("publishes the persisted dirty session to the lifecycle projection", async () => {
    let current = structuredClone(cleanProject)
    const projects = {
      get current(): ProjectSession {
        return structuredClone(current)
      },
      markExternalStateDirty: vi.fn(async () => {
        current = { ...current, dirty: true }
        return true
      })
    }
    const lifecycle = { syncProject: vi.fn() }

    await commitExternalProjectDirty(projects, lifecycle)

    expect(projects.markExternalStateDirty).toHaveBeenCalledOnce()
    expect(lifecycle.syncProject).toHaveBeenCalledWith({ ...cleanProject, dirty: true })
  })

  it("does not republish an already dirty project", async () => {
    const projects = {
      current: { ...cleanProject, dirty: true },
      markExternalStateDirty: vi.fn(async () => false)
    }
    const lifecycle = { syncProject: vi.fn() }

    await commitExternalProjectDirty(projects, lifecycle)

    expect(lifecycle.syncProject).not.toHaveBeenCalled()
  })

  it("does not publish a dirty projection when persistence fails", async () => {
    const projects = {
      current: cleanProject,
      markExternalStateDirty: vi.fn(async () => {
        throw new Error("working copy unavailable")
      })
    }
    const lifecycle = { syncProject: vi.fn() }

    await expect(commitExternalProjectDirty(projects, lifecycle)).rejects.toThrow(
      "working copy unavailable"
    )
    expect(lifecycle.syncProject).not.toHaveBeenCalled()
  })
})

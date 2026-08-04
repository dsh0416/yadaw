import { mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ProjectWorkingCopyStore } from "./project-working-copy-store"

describe("ProjectWorkingCopyStore", () => {
  it("persists dirty metadata and invalidates recovery when the archive changes", async () => {
    const userData = await mkdtemp(join(tmpdir(), "heron-working-copy-"))
    const projectPath = join(userData, "Session.heron")
    await writeFile(projectPath, "archive-v1")
    const store = new ProjectWorkingCopyStore(userData)
    const workingRoot = store.root("session-id")
    await store.reset(workingRoot)
    await store.write(workingRoot, {
      id: "session-id",
      projectPath,
      configuration: {
        name: "Session",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: true
    })

    await expect(store.read(workingRoot)).resolves.toMatchObject({
      id: "session-id",
      projectPath,
      dirty: true
    })
    await expect(store.isRecoverable(workingRoot, projectPath)).resolves.toBe(true)

    const changed = new Date(Date.now() + 2_000)
    await utimes(projectPath, changed, changed)
    await expect(store.isRecoverable(workingRoot, projectPath)).resolves.toBe(false)
  })
})

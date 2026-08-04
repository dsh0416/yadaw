import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ProjectArchiveJournal } from "./project-archive-journal"

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe("ProjectArchiveJournal", () => {
  it("commits a dump through the journal and preserves the previous archive as backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "heron-archive-journal-"))
    const target = join(root, "Project.heron")
    const temporary = join(root, ".Project.tmp")
    const backup = `${target}.bak`
    await writeFile(target, "old")
    const journal = new ProjectArchiveJournal(root)

    await journal.commit({
      operationId: "save-1",
      target,
      temporary,
      backup,
      dump: (path) => writeFile(path, "new")
    })

    expect(await readFile(target, "utf8")).toBe("new")
    expect(await readFile(backup, "utf8")).toBe("old")
    expect(await exists(temporary)).toBe(false)
  })

  it("restores the backup when recovery finds a rename interrupted before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "heron-archive-rollback-"))
    const target = join(root, "Project.heron")
    const temporary = join(root, ".Project.tmp")
    const backup = `${target}.bak`
    const journalDirectory = join(root, "project-operation-journal")
    await mkdir(journalDirectory, { recursive: true })
    await writeFile(temporary, "candidate")
    await writeFile(backup, "old")
    await writeFile(
      join(journalDirectory, "save-2.json"),
      JSON.stringify({
        version: 1,
        operationId: "save-2",
        stage: "backup-created",
        target,
        temporary,
        backup,
        targetExisted: true
      })
    )

    await new ProjectArchiveJournal(root).recover()

    expect(await readFile(target, "utf8")).toBe("old")
    expect(await exists(temporary)).toBe(false)
  })

  it("keeps the new archive when recovery observes the commit rename after response loss", async () => {
    const root = await mkdtemp(join(tmpdir(), "heron-archive-committed-"))
    const target = join(root, "Project.heron")
    const temporary = join(root, ".Project.tmp")
    const backup = `${target}.bak`
    const journalDirectory = join(root, "project-operation-journal")
    await mkdir(journalDirectory, { recursive: true })
    await writeFile(target, "new")
    await writeFile(backup, "old")
    await writeFile(
      join(journalDirectory, "save-3.json"),
      JSON.stringify({
        version: 1,
        operationId: "save-3",
        stage: "backup-created",
        target,
        temporary,
        backup,
        targetExisted: true
      })
    )

    await new ProjectArchiveJournal(root).recover()

    expect(await readFile(target, "utf8")).toBe("new")
    expect(await readFile(backup, "utf8")).toBe("old")
  })
})

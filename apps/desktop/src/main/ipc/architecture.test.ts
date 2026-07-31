import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const sourceRoot = join(import.meta.dirname, "..", "..")

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return sourceFiles(path)
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
    })
  )
  return nested.flat()
}

async function filesContaining(pattern: RegExp): Promise<string[]> {
  const files = await sourceFiles(sourceRoot)
  const matches = await Promise.all(
    files.map(async (file) => ((await readFile(file, "utf8")).match(pattern) ? file : null))
  )
  return matches
    .filter((file): file is string => file !== null)
    .map((file) => relative(sourceRoot, file).replaceAll("\\", "/"))
    .sort()
}

describe("IPC v2 architecture gate", () => {
  it("allows direct ipcMain.handle only in frozen legacy handlers and the v2 wrapper", async () => {
    await expect(filesContaining(/\bipcMain\.handle\s*\(/)).resolves.toEqual([
      "main/ipc/audio-handlers.ts",
      "main/ipc/diagnostic-handlers.ts",
      "main/ipc/midi-handlers.ts",
      "main/ipc/mixer-handlers.ts",
      "main/ipc/plugin-handlers.ts",
      "main/ipc/project-handlers.ts",
      "main/ipc/recording-handlers.ts",
      "main/ipc/rpc.ts",
      "main/ipc/settings-handlers.ts",
      "main/ipc/system-handlers.ts",
      "main/ipc/transport-handlers.ts",
      "main/startup.ts"
    ])
  })

  it("allows direct ipcRenderer.invoke only in the frozen preload and the v2 wrapper", async () => {
    await expect(filesContaining(/\bipcRenderer\.invoke\s*\(/)).resolves.toEqual([
      "preload/index.ts",
      "preload/rpc.ts"
    ])
  })

  it("keeps project lifecycle routes on the typed RPC wrappers", async () => {
    const main = await readFile(join(sourceRoot, "main", "ipc", "project-handlers.ts"), "utf8")
    const preload = await readFile(join(sourceRoot, "preload", "index.ts"), "utf8")
    for (const channel of ["projectCreate", "projectPrepareOpen", "projectOpen", "projectClose"]) {
      expect(main).toMatch(new RegExp(`registerRpcHandler\\(\\s*IPC_CHANNELS\\.${channel}`))
      expect(main).not.toContain(`ipcMain.handle(IPC_CHANNELS.${channel}`)
      expect(preload).toMatch(new RegExp(`invokeRpc\\(\\s*IPC_CHANNELS\\.${channel}`))
    }
  })
})

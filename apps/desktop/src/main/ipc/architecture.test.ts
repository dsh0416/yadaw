import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"

const sourceRoot = join(import.meta.dirname, "..", "..")
const repositoryRoot = join(sourceRoot, "..", "..", "..")

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
  it("allows direct ipcMain.handle only in the v2 wrapper", async () => {
    await expect(filesContaining(/\bipcMain\.handle\s*\(/)).resolves.toEqual(["main/ipc/rpc.ts"])
  })

  it("allows direct ipcRenderer.invoke only in the v2 wrapper", async () => {
    await expect(filesContaining(/\bipcRenderer\.invoke\s*\(/)).resolves.toEqual(["preload/rpc.ts"])
  })
  it("keeps bootstrap as the only targetless state snapshot request", async () => {
    await expect(filesContaining(/startupProgressSnapshot/)).resolves.toEqual([])
  })

  it("keeps operation failures typed and resource-scoped", async () => {
    const contracts = await readFile(
      join(repositoryRoot, "packages", "contracts", "src", "operations.ts"),
      "utf8"
    )
    const service = await readFile(join(sourceRoot, "main", "operation-service.ts"), "utf8")
    expect(contracts).toContain("error: RpcError | null")
    expect(contracts).not.toMatch(/\bmessage:\s*string\s*\|\s*null/)
    expect(service).not.toContain("legacy-desktop")
    expect(service).not.toContain("legacy-")
  })

  it("does not serialize project worker messages or stacks as errors", async () => {
    const protocol = await readFile(
      join(repositoryRoot, "packages", "project-db", "src", "protocol.ts"),
      "utf8"
    )
    expect(protocol).toContain("error: RpcError")
    expect(protocol).not.toMatch(/\bstack\??:\s*string/)
    expect(protocol).not.toMatch(/error:\s*\{[^}]*\bmessage:/s)
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

  it("keeps project graph, command, and save routes on the typed RPC wrappers", async () => {
    const project = await readFile(join(sourceRoot, "main", "ipc", "project-handlers.ts"), "utf8")
    const mixer = await readFile(join(sourceRoot, "main", "ipc", "mixer-handlers.ts"), "utf8")
    const preload = await readFile(join(sourceRoot, "preload", "index.ts"), "utf8")
    for (const channel of ["projectGraphLoad", "projectGraphReload", "projectCommandExecute"]) {
      expect(mixer).toMatch(new RegExp(`registerRpcHandler\\(\\s*IPC_CHANNELS\\.${channel}`))
      expect(mixer).not.toContain(`ipcMain.handle(IPC_CHANNELS.${channel}`)
      expect(preload).toMatch(new RegExp(`invokeRpc\\(\\s*IPC_CHANNELS\\.${channel}`))
    }
    expect(project).toMatch(/registerRpcHandler\(\s*IPC_CHANNELS\.projectSave/)
    expect(project).not.toContain("ipcMain.handle(IPC_CHANNELS.projectSave")
    expect(preload).toMatch(/invokeRpc\(\s*IPC_CHANNELS\.projectSave/)
  })

  it("keeps recording lifecycle and recovery routes on typed resource RPC", async () => {
    const main = await readFile(
      join(sourceRoot, "main", "ipc", "recording-rpc-handlers.ts"),
      "utf8"
    )
    const legacy = await readFile(join(sourceRoot, "main", "ipc", "recording-handlers.ts"), "utf8")
    const preload = await readFile(join(sourceRoot, "preload", "index.ts"), "utf8")
    for (const channel of [
      "recordingStart",
      "recordingStop",
      "recordingPendingList",
      "recordingRecover",
      "recordingDeletePending",
      "recordingWaveformSnapshot"
    ]) {
      expect(main).toMatch(new RegExp(`registerRpcHandler\\(\\s*IPC_CHANNELS\\.${channel}`))
      expect(legacy).not.toContain(`ipcMain.handle(IPC_CHANNELS.${channel}`)
      expect(preload).toMatch(new RegExp(`invokeRpc\\(\\s*IPC_CHANNELS\\.${channel}`))
    }
  })
})

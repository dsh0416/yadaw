import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  showSaveDialog: vi.fn(),
  showOpenDialog: vi.fn(),
  getAllWindows: vi.fn(() => []),
  fromWebContents: vi.fn(),
  shellOpenPath: vi.fn(async () => ""),
  quit: vi.fn(),
  showAboutPanel: vi.fn(),
  getPath: vi.fn(() => "/tmp/heron-test")
}))

vi.mock("electron", () => ({
  app: {
    getPath: electronMocks.getPath,
    quit: electronMocks.quit,
    showAboutPanel: electronMocks.showAboutPanel
  },
  ipcMain: { handle: electronMocks.handle },
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
    showOpenDialog: electronMocks.showOpenDialog
  },
  shell: { openPath: electronMocks.shellOpenPath },
  BrowserWindow: {
    getAllWindows: electronMocks.getAllWindows,
    fromWebContents: electronMocks.fromWebContents
  }
}))

import { IPC_CHANNELS } from "@heron/contracts"
import {
  createContext,
  createWorkspace,
  emptyGraph,
  installWorkspace,
  invoke,
  meta,
  mutationMeta,
  projectSession
} from "./test-harness"
import { registerProjectHandlers } from "./project-handlers"
import { AudioImportBatchError } from "../project"

vi.mock("../app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app")>()),
  t: (key: string) => key
}))

const createRequest = {
  name: "Demo",
  sampleRate: 48_000,
  timeSignatureNumerator: 4,
  timeSignatureDenominator: 4,
  waveformDisplayMode: "separate" as const
}

describe("registerProjectHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
    electronMocks.showSaveDialog.mockReset()
    electronMocks.showOpenDialog.mockReset()
    delete process.env.HERON_TEST_PROJECT_PATH
  })

  it("bootstraps without a target or mutation", async () => {
    const context = createContext()
    const bootstrap = {
      ok: true as const,
      requestId: "request-1",
      value: { ready: true },
      warnings: []
    }
    vi.mocked(context.projectLifecycle.bootstrap).mockReturnValue(bootstrap as never)
    registerProjectHandlers(context)

    const result = await invoke(electronMocks, IPC_CHANNELS.bootstrap, meta())

    expect(result).toEqual(bootstrap)
  })

  it("rejects bootstrap when a target is supplied", async () => {
    const context = createContext()
    registerProjectHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.bootstrap,
      meta({ target: context.lifecycle.applicationState.desktopSession })
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "target" } }
    })
  })

  it("creates a project using an explicit path", async () => {
    const context = createContext()
    const workspace = createWorkspace()
    vi.mocked(context.projectLifecycle.create).mockResolvedValue({
      ok: true,
      requestId: "request-1",
      value: workspace,
      warnings: []
    } as never)
    registerProjectHandlers(context)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectCreate, meta(), {
      ...createRequest,
      path: "/projects/demo.heron"
    })

    expect(context.projectLifecycle.create).toHaveBeenCalled()
    expect(result).toMatchObject({ ok: true, value: workspace })
  })

  it("cancels create when the save dialog is dismissed", async () => {
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const context = createContext()
    registerProjectHandlers(context)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectCreate, meta(), createRequest)

    expect(result).toMatchObject({ ok: false, error: { code: "operation-cancelled" } })
  })

  it("rejects invalid create requests", async () => {
    const context = createContext()
    registerProjectHandlers(context)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectCreate, meta(), { name: 42 })

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "request" } }
    })
  })

  it("prepares open with an explicit path", async () => {
    const context = createContext()
    vi.mocked(context.projects.hasRecoverableWorkingCopy).mockResolvedValue(true)
    registerProjectHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectPrepareOpen,
      meta(),
      "/projects/demo.heron"
    )

    expect(result).toMatchObject({
      ok: true,
      value: { path: "/projects/demo.heron", recoverableWorkingCopy: true }
    })
  })

  it("returns null when prepare-open dialog is cancelled", async () => {
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const context = createContext()
    registerProjectHandlers(context)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectPrepareOpen, meta())

    expect(result).toMatchObject({ ok: true, value: null })
  })

  it("rejects blank prepare-open paths", async () => {
    const context = createContext()
    registerProjectHandlers(context)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectPrepareOpen, meta(), "   ")

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "path" } }
    })
  })

  it("rejects project paths with the legacy extension", async () => {
    const context = createContext()
    registerProjectHandlers(context)
    const legacyExtension = ["ya", "daw"].join("")

    const prepareResult = await invoke(
      electronMocks,
      IPC_CHANNELS.projectPrepareOpen,
      meta(),
      `/projects/demo.${legacyExtension}`
    )
    const openResult = await invoke(
      electronMocks,
      IPC_CHANNELS.projectOpen,
      meta(),
      `/projects/demo.${legacyExtension}`,
      false
    )

    expect(prepareResult).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "path" } }
    })
    expect(openResult).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "path" } }
    })
  })

  it("opens a project through the lifecycle service", async () => {
    const context = createContext()
    const workspace = createWorkspace()
    vi.mocked(context.projectLifecycle.open).mockResolvedValue({
      ok: true,
      requestId: "request-1",
      value: workspace,
      warnings: []
    } as never)
    registerProjectHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectOpen,
      meta(),
      "/projects/demo.heron",
      true
    )

    expect(context.projectLifecycle.open).toHaveBeenCalledWith(
      expect.anything(),
      "/projects/demo.heron",
      true
    )
    expect(result).toMatchObject({ ok: true, value: workspace })
  })

  it("rejects open with a non-boolean recover flag", async () => {
    const context = createContext()
    registerProjectHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectOpen,
      meta(),
      "/projects/demo.heron",
      "yes"
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "recover" } }
    })
  })

  it("saves the current project", async () => {
    const context = createContext()
    const saved = { ...projectSession, dirty: false }
    vi.mocked(context.projects.save).mockResolvedValue(saved)
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectSave,
      mutationMeta(workspace.project, { expectedRevision: workspace.revision }),
      undefined
    )

    expect(result).toMatchObject({
      ok: true,
      value: expect.objectContaining({ session: saved })
    })
    expect(context.recordings.cleanupCommittedForProject).toHaveBeenCalledWith(saved.path)
  })

  it("maps pre-commit save failures to unavailable", async () => {
    const context = createContext()
    vi.mocked(context.projects.save).mockRejectedValue(new Error("disk full"))
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectSave,
      mutationMeta(workspace.project, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-save-fail", idempotencyKey: "idem-save-fail" }
      })
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-unavailable", outcome: "not-committed" }
    })
  })

  it("does not commit an archive when plug-in state synchronization fails", async () => {
    const context = createContext()
    vi.mocked(context.synchronizePluginStates).mockRejectedValue(
      new Error("plug-in state unavailable")
    )
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectSave,
      mutationMeta(workspace.project, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-state-fail", idempotencyKey: "idem-state-fail" }
      })
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-unavailable", outcome: "not-committed" }
    })
    expect(context.projects.save).not.toHaveBeenCalled()
  })

  it("maps post-archive save cleanup failures to timeout-unknown", async () => {
    const context = createContext()
    const saved = { ...projectSession, dirty: false }
    vi.mocked(context.projects.save).mockResolvedValue(saved)
    vi.mocked(context.recordings.cleanupCommittedForProject).mockRejectedValue(
      new Error("cleanup failed")
    )
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectSave,
      mutationMeta(workspace.project, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-save-unknown", idempotencyKey: "idem-save-unknown" }
      })
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-timeout-unknown", outcome: "unknown" }
    })
  })

  it("closes with an explicit disposition", async () => {
    const context = createContext()
    vi.mocked(context.projectLifecycle.close).mockImplementation(
      async (_meta, _disposition, hooks) => {
        await hooks?.stopTransport?.()
        return {
          ok: true,
          requestId: "request-1",
          value: { closed: true },
          warnings: []
        } as never
      }
    )
    registerProjectHandlers(context)
    installWorkspace(context.lifecycle)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectClose, meta(), "discard")

    expect(result).toMatchObject({ ok: true, value: { closed: true } })
    expect(context.assetAudition.stop).toHaveBeenCalledOnce()
    expect(context.transport.command).toHaveBeenCalledWith({ type: "stop" })
    expect(context.synchronizePluginStates).not.toHaveBeenCalled()
    expect(context.recordings.cleanupCommittedForProject).not.toHaveBeenCalled()
  })

  it("keeps save preparation and committed cleanup inside the close operation", async () => {
    const context = createContext()
    vi.mocked(context.projectLifecycle.close).mockImplementation(
      async (_meta, _disposition, hooks) => {
        await hooks?.preparePersistedState?.()
        await hooks?.stopTransport?.()
        await hooks?.cleanupCommittedState?.()
        return {
          ok: true,
          requestId: "request-1",
          value: { closed: true },
          warnings: []
        } as never
      }
    )
    registerProjectHandlers(context)
    installWorkspace(context.lifecycle)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectClose, meta(), "save")

    expect(result).toMatchObject({ ok: true, value: { closed: true } })
    expect(context.synchronizePluginStates).toHaveBeenCalledOnce()
    expect(context.transport.command).toHaveBeenCalledWith({ type: "stop" })
    expect(context.recordings.cleanupCommittedForProject).toHaveBeenCalledWith(projectSession.path)
  })

  it("requires a disposition for dirty projects", async () => {
    const context = createContext((ctx) => {
      Object.defineProperty(ctx.projects, "current", {
        get: () => ({ ...projectSession, dirty: true })
      })
    })
    registerProjectHandlers(context)

    const result = await invoke(electronMocks, IPC_CHANNELS.projectClose, meta())

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "disposition" } }
    })
  })

  it("lists project assets for the workspace", async () => {
    const assets = [{ id: "asset-1", name: "Take" }]
    const context = createContext()
    vi.mocked(context.projects.listAssets).mockResolvedValue(assets as never)
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectAssetsList,
      meta({ target: workspace.project })
    )

    expect(result).toMatchObject({ ok: true, value: assets })
  })

  it("starts and stops one project audio audition", async () => {
    const context = createContext()
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const started = await invoke(
      electronMocks,
      IPC_CHANNELS.assetAuditionStart,
      meta({ target: workspace.project }),
      "asset-1"
    )
    const stopped = await invoke(
      electronMocks,
      IPC_CHANNELS.assetAuditionStop,
      meta({ target: workspace.project })
    )

    expect(started).toMatchObject({ ok: true })
    expect(stopped).toMatchObject({ ok: true })
    expect(context.assetAudition.start).toHaveBeenCalledWith("asset-1")
    expect(context.assetAudition.stop).toHaveBeenCalledOnce()
  })

  it("imports audio and publishes the refreshed project assets", async () => {
    const asset = {
      id: "audio-1",
      kind: "audio" as const,
      name: "Kick.mp3",
      contentHash: "hash-1",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32" as const,
      frameCount: 48_000n
    }
    const context = createContext()
    vi.mocked(context.audioImport.import).mockResolvedValue({
      selectedAssetIds: [asset.id],
      importedAssetIds: [asset.id]
    })
    vi.mocked(context.projects.listAssets).mockResolvedValue([asset])
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectAudioImport,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      ["/samples/Kick.mp3"]
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedAssetIds: [asset.id],
        importedAssetIds: [asset.id],
        workspace: { assets: [asset] }
      }
    })
  })

  it("quarantines an audio import whose database commit outcome is unknown", async () => {
    const context = createContext()
    vi.mocked(context.audioImport.import).mockRejectedValue(
      new AudioImportBatchError(new Error("worker disconnected"), true, [])
    )
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectAudioImport,
      mutationMeta(workspace.projectGraph, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-audio-unknown", idempotencyKey: "idem-audio-unknown" }
      }),
      ["/samples/Kick.wav"]
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-timeout-unknown", outcome: "unknown" }
    })
  })

  it("returns known partial audio imports with a committed projection and warning", async () => {
    const asset = {
      id: "audio-1",
      kind: "audio" as const,
      name: "Kick.wav",
      contentHash: "hash-1",
      sampleRate: 48_000,
      channels: 2,
      bitDepth: "float32" as const,
      frameCount: 48_000n
    }
    const context = createContext()
    vi.mocked(context.audioImport.import).mockRejectedValue(
      new AudioImportBatchError(new Error("Snare.flac is corrupt"), false, [asset.id], [asset.id])
    )
    vi.mocked(context.projects.listAssets).mockResolvedValue([asset])
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectAudioImport,
      mutationMeta(workspace.projectGraph, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-audio-partial", idempotencyKey: "idem-audio-partial" }
      }),
      ["/samples/Kick.wav", "/samples/Snare.flac"]
    )

    expect(result).toMatchObject({
      ok: true,
      value: {
        selectedAssetIds: [asset.id],
        importedAssetIds: [asset.id],
        workspace: { assets: [asset] }
      },
      warnings: [
        {
          code: "audio-import-partial",
          userMessageKey: "errors.audioImportPartial"
        }
      ]
    })
  })

  it("updates project configuration", async () => {
    const context = createContext()
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const configuration = {
      ...projectSession.configuration,
      name: "Renamed"
    }

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectConfigurationUpdate,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      configuration
    )

    expect(result).toMatchObject({
      ok: true,
      value: expect.objectContaining({
        configuration: expect.objectContaining({ name: "Renamed" })
      })
    })
  })

  it("maps configuration update failures after commit to unavailable when rollback succeeds", async () => {
    const context = createContext()
    vi.mocked(context.projects.updateConfiguration).mockResolvedValueOnce({
      ...projectSession,
      configuration: { ...projectSession.configuration, name: "Renamed" },
      dirty: true
    })
    vi.mocked(context.projectGraph.refreshFromDatabase)
      .mockRejectedValueOnce(new Error("graph failed"))
      .mockResolvedValueOnce(emptyGraph)
    vi.mocked(context.projects.updateConfiguration).mockResolvedValueOnce(projectSession)
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectConfigurationUpdate,
      mutationMeta(workspace.projectGraph, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-config", idempotencyKey: "idem-config" }
      }),
      { ...projectSession.configuration, name: "Renamed" }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-unavailable", outcome: "not-committed" }
    })
  })

  it("maps configuration update failures to invariant-violation when rollback fails", async () => {
    const context = createContext()
    vi.mocked(context.projects.updateConfiguration).mockResolvedValueOnce({
      ...projectSession,
      configuration: { ...projectSession.configuration, name: "Renamed" },
      dirty: true
    })
    vi.mocked(context.projectGraph.refreshFromDatabase).mockRejectedValue(new Error("graph failed"))
    vi.mocked(context.projects.updateConfiguration).mockResolvedValueOnce(projectSession)
    registerProjectHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.projectConfigurationUpdate,
      mutationMeta(workspace.projectGraph, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-config-quarantine", idempotencyKey: "idem-config-quarantine" }
      }),
      { ...projectSession.configuration, name: "Renamed" }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "invariant-violation", outcome: "quarantined" }
    })
  })
})

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
  installWorkspace,
  invoke,
  meta,
  mutationMeta
} from "./test-harness"
import { registerMidiRpcHandlers } from "./midi-rpc-handlers"

vi.mock("../i18n", () => ({
  t: (key: string) => key
}))

const midiPreferences = {
  enabled: true,
  sourcePortId: "port-1",
  sourcePortName: "Keyboard",
  inputOffsetsMs: { "port-1": 0 }
}

describe("registerMidiRpcHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
    electronMocks.showOpenDialog.mockReset()
  })

  it("returns a midi input snapshot for the runtime target", async () => {
    const context = createContext()
    registerMidiRpcHandlers(context)
    const resources = context.lifecycle.applicationState.audioResourceSnapshot()

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiInputSnapshot,
      meta({ target: resources.midiRuntime })
    )

    expect(result).toMatchObject({
      ok: true,
      value: expect.objectContaining({
        runtime: resources.midiRuntime,
        snapshot: expect.objectContaining({ ports: [] })
      })
    })
  })

  it("rejects midi snapshots when the helper epoch is stale", async () => {
    const context = createContext((ctx) => {
      vi.mocked(ctx.audioHost.helperEpoch).mockReturnValue("other-epoch")
    })
    registerMidiRpcHandlers(context)
    const resources = context.lifecycle.applicationState.audioResourceSnapshot()

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiInputSnapshot,
      meta({ target: resources.midiRuntime })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("configures midi input preferences", async () => {
    const context = createContext()
    registerMidiRpcHandlers(context)
    const resources = context.lifecycle.applicationState.audioResourceSnapshot()
    const resolved = context.lifecycle.applicationState.resources.resolve(resources.midiRuntime)
    if (!resolved.ok) throw new Error("midi runtime missing")

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiInputConfigure,
      mutationMeta(resources.midiRuntime, { expectedRevision: resolved.value.revision }),
      midiPreferences
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.audioHost.configureMidiInput).toHaveBeenCalled()
    expect(context.settings.configureMidiInput).toHaveBeenCalledWith(midiPreferences)
  })

  it("rejects invalid midi preferences", async () => {
    const context = createContext()
    registerMidiRpcHandlers(context)
    const resources = context.lifecycle.applicationState.audioResourceSnapshot()
    const resolved = context.lifecycle.applicationState.resources.resolve(resources.midiRuntime)
    if (!resolved.ok) throw new Error("midi runtime missing")

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiInputConfigure,
      mutationMeta(resources.midiRuntime, {
        expectedRevision: resolved.value.revision,
        mutation: { operationId: "op-midi-bad", idempotencyKey: "idem-midi-bad" }
      }),
      { enabled: "yes" }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("rejects midi configure while recording", async () => {
    const context = createContext((ctx) => {
      Object.defineProperty(ctx.recordings, "current", { get: () => ({ id: "rec" }) })
    })
    registerMidiRpcHandlers(context)
    const resources = context.lifecycle.applicationState.audioResourceSnapshot()
    const resolved = context.lifecycle.applicationState.resources.resolve(resources.midiRuntime)
    if (!resolved.ok) throw new Error("midi runtime missing")

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiInputConfigure,
      mutationMeta(resources.midiRuntime, {
        expectedRevision: resolved.value.revision,
        mutation: { operationId: "op-midi-busy", idempotencyKey: "idem-midi-busy" }
      }),
      midiPreferences
    )

    expect(result).toMatchObject({ ok: false, error: { code: "resource-busy" } })
  })

  it("toggles midi control learning", async () => {
    const context = createContext()
    registerMidiRpcHandlers(context)
    const resources = context.lifecycle.applicationState.audioResourceSnapshot()
    const resolved = context.lifecycle.applicationState.resources.resolve(resources.midiRuntime)
    if (!resolved.ok) throw new Error("midi runtime missing")

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiControlLearning,
      mutationMeta(resources.midiRuntime, { expectedRevision: resolved.value.revision }),
      true
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.audioHost.setMidiControlLearning).toHaveBeenCalledWith(true)
  })

  it("rejects non-boolean learning values", async () => {
    const context = createContext()
    registerMidiRpcHandlers(context)
    const resources = context.lifecycle.applicationState.audioResourceSnapshot()

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiControlLearning,
      mutationMeta(resources.midiRuntime),
      "yes"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("prepares a midi import from an explicit path", async () => {
    const prepared = { token: "token-1", tracks: [{ id: 0, name: "Track" }] }
    const context = createContext()
    vi.mocked(context.midiImport.prepare).mockResolvedValue(prepared as never)
    registerMidiRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiImportPrepare,
      mutationMeta(workspace.project),
      "/files/demo.mid"
    )

    expect(result).toMatchObject({ ok: true, value: prepared })
  })

  it("returns null when the import dialog is cancelled", async () => {
    electronMocks.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const context = createContext()
    registerMidiRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiImportPrepare,
      mutationMeta(workspace.project, {
        mutation: { operationId: "op-prepare", idempotencyKey: "idem-prepare" }
      })
    )

    expect(result).toMatchObject({ ok: true, value: null })
  })

  it("commits a valid midi import plan", async () => {
    const workspace = createWorkspace({ revision: 2 })
    const context = createContext()
    vi.mocked(context.midiImport.commit).mockResolvedValue({
      command: { ok: true },
      workspace
    } as never)
    registerMidiRpcHandlers(context)
    const installed = installWorkspace(context.lifecycle)
    const plan = {
      token: "token-1",
      insertionTick: 0,
      importTempoMap: true,
      tracks: [{ sourceTrackIndex: 0, destinationTrackId: null }]
    }

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiImportCommit,
      mutationMeta(installed.projectGraph, { expectedRevision: installed.revision }),
      plan
    )

    expect(result).toMatchObject({
      ok: true,
      value: expect.objectContaining({ workspace })
    })
  })

  it("rejects invalid import plans", async () => {
    const context = createContext()
    registerMidiRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiImportCommit,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      { token: "", tracks: [] }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("maps pre-commit failures to unavailable", async () => {
    const context = createContext()
    vi.mocked(context.midiImport.commit).mockRejectedValue(new Error("import failed"))
    registerMidiRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const plan = {
      token: "token-1",
      insertionTick: 0,
      importTempoMap: false,
      tracks: []
    }

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiImportCommit,
      mutationMeta(workspace.projectGraph, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-commit-fail", idempotencyKey: "idem-commit-fail" }
      }),
      plan
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "resource-unavailable", outcome: "not-committed" }
    })
  })

  it("maps post-commit resource advance failures to unknown outcome", async () => {
    const context = createContext()
    vi.mocked(context.midiImport.commit).mockRejectedValue(
      new Error("Committed MIDI import resource could not advance")
    )
    registerMidiRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)
    const plan = {
      token: "token-1",
      insertionTick: 0,
      importTempoMap: false,
      tracks: []
    }

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.midiImportCommit,
      mutationMeta(workspace.projectGraph, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-commit-unknown", idempotencyKey: "idem-commit-unknown" }
      }),
      plan
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "operation-timeout-unknown", outcome: "unknown" }
    })
  })
})

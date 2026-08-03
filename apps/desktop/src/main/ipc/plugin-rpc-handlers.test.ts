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
  getPath: vi.fn(() => "/tmp/yadaw-test")
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

import { IPC_CHANNELS } from "@yadaw/contracts"
import type {
  PluginDescriptor,
  PluginInstanceState,
  PluginRuntimeStatus,
  ProjectWorkspaceSnapshot
} from "@yadaw/contracts"
import {
  createContext,
  emptyGraph,
  installWorkspace,
  invoke,
  meta,
  mutationMeta
} from "./test-harness"
import { registerPluginRpcHandlers } from "./plugin-rpc-handlers"

const descriptor: PluginDescriptor = {
  source: { kind: "external" },
  classId: "ABCDEF0123456789ABCDEF0123456789",
  modulePath: "/plugins/Effect.vst3",
  name: "Effect",
  vendor: "YADAW",
  version: "1.0",
  categories: ["Fx"],
  kind: "effect",
  architecture: "x86_64",
  buses: [],
  supportedAudioModes: ["stereo"],
  hasEditor: true,
  compatibility: "compatible",
  compatibilityReason: null
}

const plugin: PluginInstanceState = {
  id: "plugin-1",
  channelId: "master",
  role: "insert",
  slotOrder: 0,
  classId: descriptor.classId,
  descriptor,
  audioMode: "stereo",
  enabled: true,
  sidechainInputs: [],
  componentState: new Uint8Array([1]),
  controllerState: new Uint8Array([2])
}

describe("registerPluginRpcHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
  })

  it("lists plugins for the desktop session", async () => {
    const context = createContext()
    vi.mocked(context.plugins.list).mockReturnValue([descriptor] as never)
    registerPluginRpcHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginsList,
      meta({ target: context.lifecycle.applicationState.desktopSession })
    )

    expect(result).toMatchObject({ ok: true, value: [descriptor] })
  })

  it("rejects plugin list for a stale desktop session", async () => {
    const context = createContext()
    registerPluginRpcHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginsList,
      meta({
        target: { kind: "desktop-session", id: "desktop", epoch: "stale", generation: 1 }
      })
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("scans plugins and commits the catalog", async () => {
    const catalog = { plugins: [descriptor], scannedAt: 10 }
    const context = createContext()
    vi.mocked(context.plugins.scan).mockResolvedValue(catalog as never)
    registerPluginRpcHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginsScan,
      mutationMeta(context.lifecycle.applicationState.desktopSession),
      {}
    )

    expect(result).toMatchObject({ ok: true, value: catalog })
  })

  it("rejects invalid scan options", async () => {
    const context = createContext()
    registerPluginRpcHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginsScan,
      mutationMeta(context.lifecycle.applicationState.desktopSession, {
        mutation: { operationId: "op-scan", idempotencyKey: "idem-scan" }
      }),
      "not-an-object"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("maps scan failures to unavailable", async () => {
    const context = createContext()
    vi.mocked(context.plugins.scan).mockRejectedValue(new Error("scanner crashed"))
    registerPluginRpcHandlers(context)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginsScan,
      mutationMeta(context.lifecycle.applicationState.desktopSession, {
        mutation: { operationId: "op-scan-fail", idempotencyKey: "idem-scan-fail" }
      }),
      {}
    )

    expect(result).toMatchObject({ ok: false, error: { code: "resource-unavailable" } })
  })

  it("opens a graph-resident plugin after an unrelated graph revision advanced", async () => {
    const context = createContext()
    const status: PluginRuntimeStatus = {
      instanceId: "plugin-1",
      state: "active",
      editorOpen: true,
      editorMode: "native",
      latencySamples: 0,
      tailSamples: null,
      error: null
    }
    vi.mocked(context.plugins.openEditor).mockResolvedValue(status)
    registerPluginRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle, {
      ...installWorkspaceDefaults(context),
      graph: { ...emptyGraph, plugins: [plugin] }
    })

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginEditorOpen,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision - 1 }),
      "plugin-1"
    )

    expect(result).toMatchObject({
      ok: true,
      value: { status, resource: expect.objectContaining({ instance: plugin }) }
    })
    expect(context.plugins.openEditor).toHaveBeenCalledWith("plugin-1")
  })

  it("rejects editor open for an unknown plugin id", async () => {
    const context = createContext()
    registerPluginRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginEditorOpen,
      mutationMeta(workspace.projectGraph, {
        expectedRevision: workspace.revision,
        mutation: { operationId: "op-open", idempotencyKey: "idem-open" }
      }),
      "missing"
    )

    expect(result).toMatchObject({ ok: false, error: { code: "stale-resource" } })
  })

  it("rejects editor open without a string instance id", async () => {
    const context = createContext()
    registerPluginRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginEditorOpen,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      42
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("closes a plugin editor", async () => {
    const context = createContext()
    registerPluginRpcHandlers(context)
    installWorkspace(context.lifecycle, {
      ...createWorkspaceFrom(context),
      graph: { ...emptyGraph, plugins: [plugin] }
    })
    const resource = await context.lifecycle.applicationState.pluginInstanceSnapshot(
      "plugin-1",
      async () => undefined
    )

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginEditorClose,
      mutationMeta(resource!.plugin, {
        expectedRevision: resource!.revision,
        mutation: { operationId: "op-close", idempotencyKey: "idem-close" }
      })
    )

    expect(result).toMatchObject({ ok: true })
    expect(context.plugins.closeEditor).toHaveBeenCalledWith("plugin-1")
  })

  it("rejects editor close for a non-plugin target", async () => {
    const context = createContext()
    registerPluginRpcHandlers(context)
    const workspace = installWorkspace(context.lifecycle)

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginEditorClose,
      mutationMeta(workspace.projectGraph)
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })

  it("returns plugin parameters", async () => {
    const parameters = [{ id: 1, title: "Gain", normalized: 0.5 }]
    const context = createContext()
    vi.mocked(context.plugins.parameters).mockResolvedValue(parameters as never)
    registerPluginRpcHandlers(context)
    installWorkspace(context.lifecycle, {
      ...createWorkspaceFrom(context),
      graph: { ...emptyGraph, plugins: [plugin] }
    })
    const resource = await context.lifecycle.applicationState.pluginInstanceSnapshot(
      "plugin-1",
      async () => undefined
    )

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginParametersGet,
      meta({ target: resource!.plugin })
    )

    expect(result).toMatchObject({ ok: true, value: parameters })
  })

  it("sets a plugin parameter with a valid command", async () => {
    const context = createContext()
    const enqueueResult = { outcome: "queued", sequence: "1" }
    vi.mocked(context.audioHost.enqueuePluginParameter).mockResolvedValue(enqueueResult as never)
    registerPluginRpcHandlers(context)
    installWorkspace(context.lifecycle, {
      ...createWorkspaceFrom(context),
      graph: { ...emptyGraph, plugins: [plugin] }
    })
    const resource = await context.lifecycle.applicationState.pluginInstanceSnapshot(
      "plugin-1",
      async () => undefined
    )
    const command = {
      plugin: resource!.plugin,
      helperEpoch: context.lifecycle.applicationState.audioHost.epoch,
      pluginGeneration: resource!.plugin.generation,
      sequence: "1",
      parameterId: 1,
      normalized: 0.25,
      gesture: "perform" as const
    }

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginParameterSet,
      mutationMeta(resource!.plugin, {
        mutation: { operationId: "op-param", idempotencyKey: "idem-param" }
      }),
      command
    )

    expect(result).toMatchObject({ ok: true, value: enqueueResult })
  })

  it("rejects malformed parameter commands", async () => {
    const context = createContext()
    registerPluginRpcHandlers(context)
    installWorkspace(context.lifecycle, {
      ...createWorkspaceFrom(context),
      graph: { ...emptyGraph, plugins: [plugin] }
    })
    const resource = await context.lifecycle.applicationState.pluginInstanceSnapshot(
      "plugin-1",
      async () => undefined
    )

    const result = await invoke(
      electronMocks,
      IPC_CHANNELS.pluginParameterSet,
      mutationMeta(resource!.plugin),
      { plugin: resource!.plugin, normalized: 2 }
    )

    expect(result).toMatchObject({ ok: false, error: { code: "validation-failed" } })
  })
})

function createWorkspaceFrom(context: ReturnType<typeof createContext>): ProjectWorkspaceSnapshot {
  const desktop = context.lifecycle.applicationState.desktopSession
  return {
    project: {
      kind: "project-session",
      id: "project",
      epoch: desktop.epoch,
      generation: 1
    },
    projectGraph: {
      kind: "project-graph",
      id: "project:graph",
      epoch: desktop.epoch,
      generation: 1
    },
    revision: 1,
    session: {
      id: "project",
      path: "/projects/demo.yadaw",
      configuration: {
        name: "Demo",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: false,
      recoveredWorkingCopy: false
    },
    graph: emptyGraph,
    assets: []
  }
}

function installWorkspaceDefaults(context: ReturnType<typeof createContext>) {
  return createWorkspaceFrom(context)
}

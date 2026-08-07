import { beforeEach, describe, expect, it, vi } from "vitest"
import { readFile, unlink, writeFile } from "node:fs/promises"

const electronMocks = vi.hoisted(() => ({
  handle: vi.fn(),
  showSaveDialog: vi.fn(),
  getAllWindows: vi.fn(() => [])
}))
vi.mock("electron", () => ({
  app: { isPackaged: false },
  ipcMain: { handle: electronMocks.handle },
  dialog: { showSaveDialog: electronMocks.showSaveDialog },
  BrowserWindow: { getAllWindows: electronMocks.getAllWindows }
}))

import { IPC_CHANNELS } from "@heron/contracts"
import type { MixerChannelState } from "@heron/contracts"
import {
  createContext,
  createWorkspace,
  emptyGraph,
  installWorkspace,
  invoke,
  mutationMeta
} from "./test-harness"
import { registerBounceHandlers } from "./bounce-handlers"

const output: MixerChannelState = {
  ...emptyGraph.channels[0]!,
  id: "output",
  kind: "output" as const,
  name: "Output 1–2",
  hardwareOutputChannels: [1, 2]
}
const request = {
  outputChannelId: output.id,
  sampleRate: "project" as const,
  channelMode: "stereo" as const,
  format: { format: "wav" as const, bitDepth: "pcm24" as const, dither: "tpdf" as const },
  normalization: { mode: "overload-protection" as const },
  startBar: 1,
  endBar: 1,
  includeTail: true
}

describe("registerBounceHandlers", () => {
  beforeEach(() => {
    electronMocks.handle.mockReset()
    electronMocks.showSaveDialog.mockReset()
  })

  it("keeps the request uncommitted when the save dialog is cancelled", async () => {
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined })
    const context = createContext()
    const workspace = installWorkspace(
      context.lifecycle,
      createWorkspace({ graph: { ...emptyGraph, projectEndTick: 3_840, channels: [output] } })
    )
    registerBounceHandlers(context)

    const result = await invoke(
      electronMocks as never,
      IPC_CHANNELS.bounceOutputStart,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      request
    )

    expect(result).toMatchObject({ ok: true, value: null })
    expect(context.operations.activeCount).toBe(0)
    expect(context.synchronizePluginStates).not.toHaveBeenCalled()
  })

  it("rejects a non-Output target before opening a save dialog", async () => {
    const context = createContext()
    const workspace = installWorkspace(
      context.lifecycle,
      createWorkspace({ graph: { ...emptyGraph, projectEndTick: 3_840 } })
    )
    registerBounceHandlers(context)

    const result = await invoke(
      electronMocks as never,
      IPC_CHANNELS.bounceOutputStart,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      { ...request, outputChannelId: "master" }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "outputChannelId" } }
    })
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it("rejects incompatible encoding settings", async () => {
    const context = createContext()
    const workspace = installWorkspace(
      context.lifecycle,
      createWorkspace({ graph: { ...emptyGraph, projectEndTick: 3_840, channels: [output] } })
    )
    registerBounceHandlers(context)

    const result = await invoke(
      electronMocks as never,
      IPC_CHANNELS.bounceOutputStart,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      {
        ...request,
        format: { format: "wav", bitDepth: "float32", dither: "tpdf" }
      }
    )

    expect(result).toMatchObject({
      ok: false,
      error: { code: "validation-failed", details: { field: "request" } }
    })
    expect(electronMocks.showSaveDialog).not.toHaveBeenCalled()
  })

  it("rechecks the graph revision after the save dialog closes", async () => {
    const context = createContext()
    const workspace = installWorkspace(
      context.lifecycle,
      createWorkspace({ graph: { ...emptyGraph, projectEndTick: 3_840, channels: [output] } })
    )
    electronMocks.showSaveDialog.mockImplementation(async () => {
      context.lifecycle.applicationState.commitWorkspaceProjection(
        workspace.session,
        { ...workspace.graph, projectEndTick: 7_680 },
        workspace.assets
      )
      return { canceled: false, filePath: "/tmp/bounce.wav" }
    })
    registerBounceHandlers(context)

    const result = await invoke(
      electronMocks as never,
      IPC_CHANNELS.bounceOutputStart,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      request
    )

    expect(result).toMatchObject({ ok: false, error: { code: "revision-conflict" } })
    expect(context.operations.activeCount).toBe(0)
    expect(context.synchronizePluginStates).not.toHaveBeenCalled()
  })

  it("commits only after the dedicated offline host and real-time host are restored", async () => {
    const destination = `/tmp/heron-bounce-handler-${process.pid}.wav`
    await writeFile(destination, "old output")
    electronMocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
    const context = createContext()
    Object.assign(context.audioHost, {
      audioEngineSnapshot: vi.fn(async () => ({ state: "stopped" })),
      refreshDesiredProjectGraph: vi.fn(),
      prepareOfflineBounce: vi.fn(async () => undefined),
      startBounceOutput: vi.fn(async (bounce: { encoded_path: string }) => {
        await writeFile(bounce.encoded_path, "new output")
      }),
      bounceOutputStatus: vi.fn(async () => ({
        operation_id: "op-1",
        state: "completed",
        phase: "encoding",
        completed_units: 1,
        total_units: 1,
        warnings: []
      })),
      restartAfterOfflineBounce: vi.fn(async () => undefined)
    })
    const workspace = installWorkspace(
      context.lifecycle,
      createWorkspace({ graph: { ...emptyGraph, projectEndTick: 3_840, channels: [output] } })
    )
    vi.mocked(context.projectGraph.snapshot).mockResolvedValue(workspace.graph)
    registerBounceHandlers(context)

    const result = await invoke(
      electronMocks as never,
      IPC_CHANNELS.bounceOutputStart,
      mutationMeta(workspace.projectGraph, { expectedRevision: workspace.revision }),
      request
    )

    expect(result).toMatchObject({
      ok: true,
      value: { operationId: "op-1", filePath: destination }
    })
    await vi.waitFor(() => {
      expect(context.operations.operationStatus("op-1")?.state).toBe("committed")
    })
    expect(await readFile(destination, "utf8")).toBe("new output")
    expect(context.audioHost.prepareOfflineBounce).toHaveBeenCalledOnce()
    expect(context.audioHost.startBounceOutput).toHaveBeenCalledWith(
      expect.objectContaining({ include_tail: true })
    )
    expect(context.audioHost.restartAfterOfflineBounce).toHaveBeenCalledWith(false)
    await unlink(destination)
  })
})

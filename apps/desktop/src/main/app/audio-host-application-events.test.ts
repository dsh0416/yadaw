import { IPC_CHANNELS } from "@heron/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AraHostCallback,
  PluginSidechainRouteRequest,
  Vst3HostNotification
} from "../audio-host"
import { bindAudioHostApplicationEvents } from "./audio-host-application-events"

describe("AudioHostApplicationEventBridge", () => {
  let araHandler: (callback: AraHostCallback) => void | Promise<void>
  let vst3Handler: (notification: Vst3HostNotification) => void | Promise<void>
  let sidechainHandler: (request: PluginSidechainRouteRequest) => void | Promise<void>
  let send: ReturnType<typeof vi.fn<(channel: string, event: unknown) => void>>
  let resolvePluginSidechainRoute: ReturnType<
    typeof vi.fn<
      (requestId: number, instanceId: string, accepted: boolean, warning?: string) => Promise<void>
    >
  >
  let execute: ReturnType<typeof vi.fn>
  let currentWorkspace: ReturnType<typeof vi.fn>
  let openEditor: ReturnType<typeof vi.fn>
  let markProjectDirty: ReturnType<typeof vi.fn<() => Promise<void>>>

  beforeEach(() => {
    send = vi.fn<(channel: string, event: unknown) => void>()
    resolvePluginSidechainRoute = vi.fn(
      async (_requestId: number, _instanceId: string, _accepted: boolean, _warning?: string) => {}
    )
    execute = vi.fn()
    currentWorkspace = vi.fn()
    openEditor = vi.fn(async () => ({ editorMode: "native", open: true }))
    markProjectDirty = vi.fn<() => Promise<void>>(async () => {})
    bindAudioHostApplicationEvents({
      audioHost: {
        helperEpoch: () => "helper-epoch",
        resolvePluginSidechainRoute,
        setAraCallbackHandler: (handler) => {
          araHandler = handler
        },
        setVst3HostNotificationHandler: (handler) => {
          vst3Handler = handler
        },
        setPluginSidechainRouteRequestHandler: (handler) => {
          sidechainHandler = handler
        }
      },
      projectCommands: { currentWorkspace, execute } as never,
      plugins: { openEditor } as never,
      sourceEpoch: "application-epoch",
      targets: () => [{ webContents: { send } }],
      markProjectDirty
    })
  })

  it("marks ARA content dirty and publishes ordered progress events", async () => {
    await araHandler({
      helperEpoch: "helper-epoch",
      instanceId: "ara-1",
      sequence: 3,
      event: {
        kind: "content-changed",
        objectKind: "playback-region",
        objectId: "clip-1",
        scopes: 1
      }
    })
    await araHandler({
      helperEpoch: "helper-epoch",
      instanceId: "ara-1",
      sequence: 4,
      event: {
        kind: "analysis-progress",
        objectId: "source-1",
        state: "updated",
        progress: 0.5
      }
    })
    await araHandler({
      helperEpoch: "helper-epoch",
      instanceId: "ara-1",
      sequence: 5,
      event: { kind: "archive-progress", direction: "store", progress: 1 }
    })

    expect(markProjectDirty).toHaveBeenCalledOnce()
    expect(send).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.araCallbackEvent,
      expect.objectContaining({
        sourceEpoch: "helper-epoch",
        sequence: 1,
        resourceRevision: 1,
        payload: expect.objectContaining({ callbackSequence: 4 })
      })
    )
    expect(send).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.araCallbackEvent,
      expect.objectContaining({ sequence: 2, resourceRevision: 2 })
    )
  })

  it("reconciles VST3 dirty and open-editor notifications", async () => {
    await vst3Handler({ instanceId: "plugin-1", kind: "dirty-changed", value: "true" })
    await vst3Handler({ instanceId: "plugin-1", kind: "open-editor", value: "editor" })

    expect(markProjectDirty).toHaveBeenCalledOnce()
    expect(openEditor).toHaveBeenCalledWith("plugin-1")
  })

  it("commits side-chain changes before acknowledging and broadcasting them", async () => {
    currentWorkspace.mockReturnValue({
      projectGraph: { kind: "project-graph", id: "project:graph", epoch: "main", generation: 1 },
      revision: 7,
      graph: {
        plugins: [
          {
            id: "plugin-1",
            descriptor: { classId: "effect" },
            sidechainInputs: [
              { inputBusIndex: 2, sourceChannelId: "old" },
              { inputBusIndex: 3, sourceChannelId: "audio-3" }
            ]
          }
        ]
      }
    })
    execute.mockResolvedValue({
      ok: true,
      resourceRevision: 8,
      value: { graph: { revision: 8 } },
      warnings: [{ code: "audio-deployment-degraded" }]
    })

    await sidechainHandler({
      requestId: 17,
      instanceId: "plugin-1",
      inputBusIndex: 2,
      sourceChannelId: "audio-2"
    })

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 7 }), {
      type: "update-plugin",
      pluginId: "plugin-1",
      patch: {
        descriptor: { classId: "effect" },
        sidechainInputs: [
          { inputBusIndex: 2, sourceChannelId: "audio-2" },
          { inputBusIndex: 3, sourceChannelId: "audio-3" }
        ]
      }
    })
    expect(send).toHaveBeenCalledWith(
      IPC_CHANNELS.projectCommandExternalEvent,
      expect.objectContaining({
        sourceEpoch: "application-epoch",
        sequence: 1,
        resourceRevision: 8
      })
    )
    expect(resolvePluginSidechainRoute).toHaveBeenCalledWith(
      17,
      "plugin-1",
      true,
      "Route saved, but audio deployment is degraded."
    )
    expect(send.mock.invocationCallOrder[0]).toBeLessThan(
      resolvePluginSidechainRoute.mock.invocationCallOrder[0]!
    )
  })

  it("rejects a side-chain request whose project resource is gone", async () => {
    currentWorkspace.mockReturnValue(null)

    await sidechainHandler({
      requestId: 18,
      instanceId: "missing",
      inputBusIndex: 1,
      sourceChannelId: null
    })

    expect(execute).not.toHaveBeenCalled()
    expect(resolvePluginSidechainRoute).toHaveBeenCalledWith(
      18,
      "missing",
      false,
      "The plug-in or project is no longer available."
    )
  })
})

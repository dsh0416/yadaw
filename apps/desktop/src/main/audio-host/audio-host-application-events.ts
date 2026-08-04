import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type { AudioHostService } from "./audio-host-service"
import type { PluginCatalogService } from "../plugins"
import type { ProjectCommandService } from "../project"

export interface ApplicationEventTarget {
  webContents: {
    send(channel: string, event: unknown): void
  }
}

export interface AudioHostApplicationEventOptions {
  audioHost: Pick<
    AudioHostService,
    | "helperEpoch"
    | "resolvePluginSidechainRoute"
    | "setAraCallbackHandler"
    | "setPluginSidechainRouteRequestHandler"
    | "setVst3HostNotificationHandler"
  >
  projectCommands: Pick<ProjectCommandService, "currentWorkspace" | "execute">
  plugins: Pick<PluginCatalogService, "openEditor">
  sourceEpoch: string
  targets: () => readonly ApplicationEventTarget[]
  markProjectDirty: () => Promise<void>
}

export class AudioHostApplicationEventBridge {
  private araSequence = 0
  private projectCommandSequence = 0

  constructor(private readonly options: AudioHostApplicationEventOptions) {}

  bind(): void {
    this.options.audioHost.setAraCallbackHandler(async (callback) => {
      if (
        callback.event.kind === "content-changed" ||
        callback.event.kind === "document-data-changed"
      ) {
        await this.options.markProjectDirty()
      }
      if (
        callback.event.kind === "analysis-progress" ||
        callback.event.kind === "archive-progress" ||
        callback.event.kind === "quarantined"
      ) {
        this.araSequence += 1
        this.broadcast(IPC_CHANNELS.araCallbackEvent, {
          protocolVersion: IPC_PROTOCOL_VERSION,
          sourceEpoch: this.options.audioHost.helperEpoch() ?? "0",
          sequence: this.araSequence,
          resourceRevision: this.araSequence,
          payload: {
            instanceId: callback.instanceId,
            callbackSequence: callback.sequence,
            event: callback.event
          }
        })
      }
    })

    this.options.audioHost.setVst3HostNotificationHandler(async (notification) => {
      if (notification.kind === "dirty-changed" && notification.value === "true") {
        await this.options.markProjectDirty()
      } else if (notification.kind === "open-editor") {
        await this.options.plugins.openEditor(notification.instanceId)
      }
    })

    this.options.audioHost.setPluginSidechainRouteRequestHandler(async (request) => {
      const workspace = this.options.projectCommands.currentWorkspace()
      const plugin = workspace?.graph.plugins.find(
        (candidate) => candidate.id === request.instanceId
      )
      if (!workspace || !plugin) {
        await this.options.audioHost.resolvePluginSidechainRoute(
          request.requestId,
          request.instanceId,
          false,
          "The plug-in or project is no longer available."
        )
        return
      }

      const sidechainInputs = plugin.sidechainInputs.filter(
        (route) => route.inputBusIndex !== request.inputBusIndex
      )
      if (request.sourceChannelId) {
        sidechainInputs.push({
          inputBusIndex: request.inputBusIndex,
          sourceChannelId: request.sourceChannelId
        })
      }
      sidechainInputs.sort((left, right) => left.inputBusIndex - right.inputBusIndex)
      const operationId = `native-sidechain:${randomUUID()}`
      const result = await this.options.projectCommands.execute(
        {
          protocolVersion: IPC_PROTOCOL_VERSION,
          requestId: `native-sidechain-request:${randomUUID()}`,
          target: structuredClone(workspace.projectGraph),
          expectedRevision: workspace.revision,
          mutation: {
            operationId,
            idempotencyKey: operationId
          }
        },
        {
          type: "update-plugin",
          pluginId: plugin.id,
          patch: { descriptor: plugin.descriptor, sidechainInputs }
        }
      )
      if (!result.ok) {
        await this.options.audioHost.resolvePluginSidechainRoute(
          request.requestId,
          request.instanceId,
          false,
          "Side-chain routing could not be committed."
        )
        return
      }

      const revision = result.resourceRevision ?? workspace.revision + 1
      this.projectCommandSequence += 1
      this.broadcast(IPC_CHANNELS.projectCommandExternalEvent, {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sourceEpoch: this.options.sourceEpoch,
        sequence: this.projectCommandSequence,
        resourceRevision: revision,
        payload: {
          result: result.value,
          warnings: result.warnings ?? []
        }
      })
      const degraded = result.warnings?.some(
        (warning) => warning.code === "audio-deployment-degraded"
      )
      await this.options.audioHost.resolvePluginSidechainRoute(
        request.requestId,
        request.instanceId,
        true,
        degraded ? "Route saved, but audio deployment is degraded." : undefined
      )
    })
  }

  private broadcast(channel: string, event: unknown): void {
    for (const target of this.options.targets()) target.webContents.send(channel, event)
  }
}

export function bindAudioHostApplicationEvents(
  options: AudioHostApplicationEventOptions
): AudioHostApplicationEventBridge {
  const bridge = new AudioHostApplicationEventBridge(options)
  bridge.bind()
  return bridge
}

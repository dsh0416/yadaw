import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type { ApplicationCommandId, RpcEvent } from "@heron/contracts"

const applicationCommandEpoch = randomUUID()
let applicationCommandSequence = 0

export interface ApplicationCommandTarget {
  show?(): void
  webContents: {
    send(channel: string, event: RpcEvent<ApplicationCommandId>): void
  }
}

export function applicationCommandEvent(
  command: ApplicationCommandId
): RpcEvent<ApplicationCommandId> {
  applicationCommandSequence += 1
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    sourceEpoch: applicationCommandEpoch,
    sequence: applicationCommandSequence,
    resourceRevision: applicationCommandSequence,
    payload: command
  }
}

export function sendApplicationCommand(
  window: ApplicationCommandTarget,
  command: ApplicationCommandId
): void {
  window.show?.()
  window.webContents.send(
    IPC_CHANNELS.applicationCommandRequested,
    applicationCommandEvent(command)
  )
}

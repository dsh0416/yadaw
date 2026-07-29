import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { TransportCommand } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { assertTrustedSender } from "./support"
export function registerTransportHandlers(context: IpcHandlerContext): void {
  const { lifecycle, mixer, isShuttingDown } = context
  ipcMain.handle(IPC_CHANNELS.transportCommand, (event, value: unknown) => {
    assertTrustedSender(event)
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      throw new TypeError("Transport command must be an object with a type")
    }
    const command = value as TransportCommand
    lifecycle.assertTransportAllowed(command)
    if (isShuttingDown()) {
      return {
        state: "stopped" as const,
        positionFrames: 0,
        sampleRate: lifecycle.snapshot().audio.runtime.sampleRate ?? 0
      }
    }
    return mixer.transport(command)
  })

  ipcMain.handle(IPC_CHANNELS.transportSnapshot, (event) => {
    assertTrustedSender(event)
    if (isShuttingDown()) {
      return {
        state: "stopped" as const,
        positionFrames: 0,
        sampleRate: lifecycle.snapshot().audio.runtime.sampleRate ?? 0
      }
    }
    return mixer.transportSnapshot()
  })
}

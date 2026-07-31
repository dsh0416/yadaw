import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { assertTrustedSender, validateWaveformRequest } from "./support"
import { registerRecordingRpcHandlers } from "./recording-rpc-handlers"
export function registerRecordingHandlers(context: IpcHandlerContext): void {
  const { projects, operations, waveforms } = context
  registerRecordingRpcHandlers(context)
  ipcMain.handle(IPC_CHANNELS.assetAudioRead, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || value.length === 0 || value.length > 256) {
      throw new TypeError("Audio asset id must be a non-empty string")
    }
    return projects.readAssetAudio(value)
  })

  ipcMain.handle(IPC_CHANNELS.assetWaveformRead, (event, value: unknown) => {
    assertTrustedSender(event)
    return waveforms.readAsset(validateWaveformRequest(value))
  })

  ipcMain.handle(IPC_CHANNELS.operationCancel, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string") throw new TypeError("Operation id must be a string")
    return operations.cancel(value)
  })
}

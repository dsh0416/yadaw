import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { assertTrustedSender, validateWaveformRequest } from "./support"
export function registerRecordingHandlers(context: IpcHandlerContext): void {
  const { recordings, projects, operations, waveforms, lifecycle } = context
  ipcMain.handle(IPC_CHANNELS.recordingStart, async (event) => {
    assertTrustedSender(event)
    lifecycle.beginRecordingStart()
    try {
      const session = await recordings.start()
      lifecycle.completeRecordingStart(session)
      return session
    } catch (error) {
      lifecycle.failRecordingStart(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.recordingStop, async (event) => {
    assertTrustedSender(event)
    const session = lifecycle.beginRecordingStop()
    try {
      const completed = await recordings.stop(() => lifecycle.markRecordingFinalizing(session))
      lifecycle.completeRecordingStop()
      lifecycle.syncProject(projects.current)
      return completed
    } catch (error) {
      lifecycle.failRecordingStop(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.recordingPendingList, (event) => {
    assertTrustedSender(event)
    return recordings.listPending()
  })

  ipcMain.handle(IPC_CHANNELS.recordingRecover, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string") throw new TypeError("Recording id must be a string")
    lifecycle.beginRecordingRecovery(value)
    try {
      await recordings.recover(value)
      lifecycle.completeRecordingRecovery()
      lifecycle.syncProject(projects.current)
    } catch (error) {
      lifecycle.failRecordingRecovery(error)
      throw error
    }
  })

  ipcMain.handle(IPC_CHANNELS.recordingDeletePending, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string") throw new TypeError("Recording id must be a string")
    lifecycle.assertRecordingIdle()
    return recordings.deletePending(value)
  })

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

  ipcMain.handle(IPC_CHANNELS.recordingWaveformSnapshot, (event, value: unknown) => {
    assertTrustedSender(event)
    return recordings.waveformSnapshot(validateWaveformRequest(value))
  })

  ipcMain.handle(IPC_CHANNELS.operationCancel, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string") throw new TypeError("Operation id must be a string")
    return operations.cancel(value)
  })
}

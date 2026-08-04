import { BrowserWindow } from "electron"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import type { ApplicationServices } from "./context"

export interface DisposableRegistration {
  dispose(): void
}

type EventPublisherServices = Pick<ApplicationServices, "audioHost" | "lifecycle" | "plugins">

export function registerIpcEventPublishers(
  services: EventPublisherServices
): DisposableRegistration {
  let disposed = false
  let midiSnapshotPending = false
  let midiSequence = 0
  let pluginSequence = 0

  const unsubscribePlugins = services.plugins.subscribe((scanEvent) => {
    if (disposed) return
    pluginSequence += 1
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.pluginsScanEvent, {
        protocolVersion: IPC_PROTOCOL_VERSION,
        sourceEpoch: services.lifecycle.applicationState.resources.epoch,
        sequence: pluginSequence,
        resourceRevision: pluginSequence,
        payload: scanEvent
      })
    }
  })

  const publishMidiSnapshot = async (): Promise<void> => {
    if (disposed || midiSnapshotPending) return
    midiSnapshotPending = true
    try {
      const nativeSnapshot = await services.audioHost.midiInputSnapshot()
      if (disposed) return
      const snapshot = services.lifecycle.applicationState.midiRuntimeSnapshot(nativeSnapshot)
      for (const window of BrowserWindow.getAllWindows()) {
        if (disposed) return
        midiSequence += 1
        window.webContents.send(IPC_CHANNELS.midiInputEvent, {
          protocolVersion: IPC_PROTOCOL_VERSION,
          sourceEpoch: services.lifecycle.applicationState.audioHost.epoch,
          sequence: midiSequence,
          resourceRevision: snapshot.revision,
          payload: snapshot
        })
      }
    } catch {
      // Helper recovery owns error reporting; the next interval retries.
    } finally {
      midiSnapshotPending = false
    }
  }

  const midiSnapshotTimer = setInterval(() => void publishMidiSnapshot(), 100)
  midiSnapshotTimer.unref()

  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      clearInterval(midiSnapshotTimer)
      unsubscribePlugins()
    }
  }
}

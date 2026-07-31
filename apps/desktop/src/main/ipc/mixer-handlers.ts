import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { MixerParameterPreview, ProjectCommand } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { assertTrustedSender } from "./support"
export function registerMixerHandlers(context: IpcHandlerContext): void {
  const { projectGraph, projectCommands, mixerRuntime, lifecycle, projects, isShuttingDown } =
    context
  ipcMain.handle(IPC_CHANNELS.projectGraphLoad, (event) => {
    assertTrustedSender(event)
    lifecycle.assertMixerLoadAllowed()
    return projectGraph.snapshot()
  })

  ipcMain.handle(IPC_CHANNELS.projectGraphReload, (event) => {
    assertTrustedSender(event)
    lifecycle.assertMixerLoadAllowed()
    return projectGraph.load()
  })

  ipcMain.handle(IPC_CHANNELS.projectCommandExecute, async (event, value: unknown) => {
    assertTrustedSender(event)
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { type?: unknown }).type !== "string"
    ) {
      throw new TypeError("Project command must be an object with a type")
    }
    const command = value as ProjectCommand
    lifecycle.assertMixerCommandAllowed(command)
    const result = await projectCommands.execute(command)
    lifecycle.syncProject(projects.current)
    return result
  })

  ipcMain.handle(IPC_CHANNELS.mixerPreview, (event, value: unknown) => {
    assertTrustedSender(event)
    if (!value || typeof value !== "object") throw new TypeError("Mixer preview must be an object")
    lifecycle.assertMixerPreviewAllowed()
    return mixerRuntime.preview(value as MixerParameterPreview)
  })

  ipcMain.handle(IPC_CHANNELS.mixerSnapshot, (event) => {
    assertTrustedSender(event)
    if (isShuttingDown()) return { meters: [], capturedAt: Date.now() }
    return mixerRuntime.runtimeSnapshot()
  })

  ipcMain.handle(IPC_CHANNELS.mixerClearMeterClips, (event) => {
    assertTrustedSender(event)
    return mixerRuntime.clearMeterClips()
  })
}

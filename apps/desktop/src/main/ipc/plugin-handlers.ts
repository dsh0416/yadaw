import { ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { PluginParameterChange } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { assertTrustedSender } from "./support"
export function registerPluginHandlers(context: IpcHandlerContext): void {
  const { plugins } = context
  ipcMain.handle(IPC_CHANNELS.pluginsList, (event) => {
    assertTrustedSender(event)
    return plugins.list()
  })

  ipcMain.handle(IPC_CHANNELS.pluginsScan, (event, value: unknown) => {
    assertTrustedSender(event)
    if (value !== undefined && (typeof value !== "object" || value === null)) {
      throw new TypeError("Plugin scan request must be an object")
    }
    return plugins.scan(value ?? {})
  })

  ipcMain.handle(IPC_CHANNELS.pluginEditorOpen, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value) throw new TypeError("Plugin instance ID is required")
    return plugins.openEditor(value)
  })

  ipcMain.handle(IPC_CHANNELS.pluginEditorClose, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value) throw new TypeError("Plugin instance ID is required")
    return plugins.closeEditor(value)
  })

  ipcMain.handle(IPC_CHANNELS.pluginParametersGet, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "string" || !value) throw new TypeError("Plugin instance ID is required")
    return plugins.parameters(value)
  })

  ipcMain.handle(IPC_CHANNELS.pluginParameterSet, (event, value: unknown) => {
    assertTrustedSender(event)
    if (typeof value !== "object" || value === null) {
      throw new TypeError("Plugin parameter change must be an object")
    }
    void plugins.setParameter(value as PluginParameterChange)
  })
}

import { app, BrowserWindow } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import { engineInfo, processGain } from "@yadaw/dsp-node"
import type { IpcHandlerContext } from "./context"
import { registerRpcHandler } from "./rpc"
import { validateMutationTarget, validateReadTarget } from "./resource-validation"
import { validateApplicationWindowCommand, validateGainRequest } from "./support"

export function registerSystemHandlers(context: IpcHandlerContext): void {
  const state = context.lifecycle.applicationState
  registerRpcHandler(IPC_CHANNELS.engineInfo, ({ meta }) => {
    const invalid = validateReadTarget(meta, state.offlineWorker)
    if (invalid) return invalid
    return engineInfo()
  })

  registerRpcHandler(IPC_CHANNELS.applicationWindowCommand, ({ event, meta }, value: unknown) => {
    const invalid = validateMutationTarget(meta, state.desktopSession)
    if (invalid) return invalid
    const command = validateApplicationWindowCommand(value)
    const window = BrowserWindow.fromWebContents(event.sender)
    switch (command) {
      case "edit.undo":
        event.sender.undo()
        break
      case "edit.redo":
        event.sender.redo()
        break
      case "edit.cut":
        event.sender.cut()
        break
      case "edit.copy":
        event.sender.copy()
        break
      case "edit.paste":
        event.sender.paste()
        break
      case "edit.select-all":
        event.sender.selectAll()
        break
      case "window.minimize":
        window?.minimize()
        break
      case "window.toggle-maximize":
        if (window?.isMaximized()) window.unmaximize()
        else window?.maximize()
        break
      case "window.close":
        window?.close()
        break
      case "application.quit":
        app.quit()
        break
      case "view.toggle-full-screen":
        if (window) window.setFullScreen(!window.isFullScreen())
        break
    }
  })

  registerRpcHandler(IPC_CHANNELS.applicationWindowTheme, ({ event, meta }, value: unknown) => {
    const invalid = validateMutationTarget(meta, state.desktopSession)
    if (invalid) return invalid
    if (value !== "light" && value !== "dark") {
      throw new TypeError("Unknown application window theme")
    }
    void Promise.resolve(
      context.audioHost.configurePluginEditorAppearance({
        ...context.audioHost.pluginEditorAppearanceSnapshot(),
        theme: value
      })
    ).catch((error: unknown) => {
      console.error("Could not update plug-in editor appearance", error)
    })
    const window = BrowserWindow.fromWebContents(event.sender)
    if (!window || process.platform !== "linux") return
    window.setTitleBarOverlay({
      color: value === "dark" ? "#151515" : "#d8d9db",
      symbolColor: value === "dark" ? "#e8e8e8" : "#202224",
      height: 38
    })
  })

  registerRpcHandler(IPC_CHANNELS.processGain, ({ meta }, value: unknown) => {
    const invalid = validateReadTarget(meta, state.offlineWorker)
    if (invalid) return invalid
    const request = validateGainRequest(value)
    return processGain(request.samples, request.gain)
  })
}

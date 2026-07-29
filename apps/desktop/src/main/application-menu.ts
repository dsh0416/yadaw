import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { ApplicationCommandId } from "@yadaw/contracts"
import { t } from "./i18n"

function requestApplicationCommand(command: ApplicationCommandId): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window) return
  window.show()
  window.webContents.send(IPC_CHANNELS.applicationCommandRequested, command)
}

function commandItem(
  label: string,
  command: ApplicationCommandId,
  accelerator?: string
): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: () => requestApplicationCommand(command)
  }
}

function macApplicationMenu(): MenuItemConstructorOptions[] {
  return [
    {
      label: t("app.name"),
      submenu: [
        { role: "about", label: t("app.about") },
        { type: "separator" },
        commandItem(t("menu.preferences"), "application.preferences", "Command+,"),
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    },
    {
      label: t("menu.file"),
      submenu: [
        commandItem(t("menu.newProject"), "project.new", "Command+N"),
        commandItem(t("menu.openProject"), "project.open", "Command+O"),
        { type: "separator" },
        commandItem(t("menu.saveProject"), "project.save", "Command+S"),
        commandItem(t("menu.closeProject"), "project.close", "Command+W"),
        { type: "separator" },
        commandItem(t("menu.projectSettings"), "project.settings", "Command+Shift+,")
      ]
    },
    {
      label: t("menu.edit"),
      submenu: [
        commandItem(t("menu.undo"), "edit.undo", "Command+Z"),
        commandItem(t("menu.redo"), "edit.redo", "Command+Shift+Z"),
        { type: "separator" },
        commandItem(t("menu.cut"), "edit.cut", "Command+X"),
        commandItem(t("menu.copy"), "edit.copy", "Command+C"),
        commandItem(t("menu.paste"), "edit.paste", "Command+V"),
        commandItem(t("menu.selectAll"), "edit.select-all", "Command+A")
      ]
    },
    {
      label: t("menu.view"),
      submenu: [
        commandItem(t("menu.toggleFullScreen"), "view.toggle-full-screen", "Control+Command+F")
      ]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        commandItem(t("menu.audioBenchmark"), "help.audio-benchmark"),
        commandItem(t("menu.effectChainGraph"), "help.effect-chain-graph")
      ]
    }
  ]
}

export function installApplicationMenu(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "darwin") {
    Menu.setApplicationMenu(null)
    return
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(macApplicationMenu()))
}

import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { ApplicationCommandId } from "@yadaw/contracts"

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
      label: "YADAW",
      submenu: [
        { role: "about", label: "About YADAW" },
        { type: "separator" },
        commandItem("Preferences…", "application.preferences", "Command+,"),
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
      label: "File",
      submenu: [
        commandItem("New Project", "project.new", "Command+N"),
        commandItem("Open Project…", "project.open", "Command+O"),
        { type: "separator" },
        commandItem("Save Project", "project.save", "Command+S"),
        commandItem("Close Project", "project.close", "Command+W"),
        { type: "separator" },
        commandItem("Project Settings…", "project.settings", "Command+Shift+,")
      ]
    },
    {
      label: "Edit",
      submenu: [
        commandItem("Undo", "edit.undo", "Command+Z"),
        commandItem("Redo", "edit.redo", "Command+Shift+Z"),
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [commandItem("Toggle Full Screen", "view.toggle-full-screen", "Control+Command+F")]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        commandItem("Audio Performance Benchmark…", "help.audio-benchmark"),
        commandItem("Effect Chain Graph…", "help.effect-chain-graph")
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

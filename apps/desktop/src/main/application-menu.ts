import { app, BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"

function requestAudioBenchmark(): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window) return
  window.show()
  window.webContents.send(IPC_CHANNELS.audioBenchmarkMenuOpen)
}

export function installApplicationMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Audio Performance Benchmark…",
          click: requestAudioBenchmark
        },
        { type: "separator" },
        {
          label: "About YADAW",
          click: () => app.showAboutPanel()
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

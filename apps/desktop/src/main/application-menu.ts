import { BrowserWindow, Menu } from "electron"
import type { MenuItemConstructorOptions } from "electron"
import { resolveKeyboardShortcuts } from "@heron/contracts"
import type {
  ApplicationCommandId,
  KeyboardShortcutBinding,
  ShortcutPreferences
} from "@heron/contracts"
import { sendApplicationCommand } from "./application-command-events"
import { t } from "./i18n"

function requestApplicationCommand(command: ApplicationCommandId): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!window) return
  sendApplicationCommand(window, command)
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

function electronAccelerator(binding: KeyboardShortcutBinding | undefined): string | undefined {
  if (!binding) return undefined
  const key = /^Key[A-Z]$/u.test(binding.code)
    ? binding.code.slice(3)
    : /^Digit[0-9]$/u.test(binding.code)
      ? binding.code.slice(5)
      : /^F(?:[1-9]|1[0-9]|2[0-4])$/u.test(binding.code)
        ? binding.code
        : (
            {
              ArrowDown: "Down",
              ArrowLeft: "Left",
              ArrowRight: "Right",
              ArrowUp: "Up",
              Backspace: "Backspace",
              Comma: ",",
              Delete: "Delete",
              End: "End",
              Enter: "Enter",
              Escape: "Escape",
              Home: "Home",
              Insert: "Insert",
              PageDown: "PageDown",
              PageUp: "PageUp",
              Period: ".",
              Space: "Space",
              Tab: "Tab"
            } as Record<string, string | undefined>
          )[binding.code]
  if (!key) return undefined
  const modifiers = binding.modifiers.map((modifier) => {
    if (modifier === "primary") return "Command"
    if (modifier === "control") return "Control"
    if (modifier === "alt") return "Option"
    return "Shift"
  })
  return [...modifiers, key].join("+")
}

function macApplicationMenu(shortcuts: ShortcutPreferences): MenuItemConstructorOptions[] {
  const keyboard = resolveKeyboardShortcuts("darwin", shortcuts)
  const accelerator = (command: ApplicationCommandId) => electronAccelerator(keyboard[command])
  return [
    {
      label: t("app.name"),
      submenu: [
        commandItem(t("app.about"), "application.about"),
        { type: "separator" },
        commandItem(
          t("menu.preferences"),
          "application.preferences",
          accelerator("application.preferences")
        ),
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
        commandItem(t("menu.newProject"), "project.new", accelerator("project.new")),
        commandItem(t("menu.openProject"), "project.open", accelerator("project.open")),
        { type: "separator" },
        commandItem(t("menu.saveProject"), "project.save", accelerator("project.save")),
        commandItem(t("menu.closeProject"), "project.close", accelerator("project.close")),
        { type: "separator" },
        commandItem(t("menu.projectSettings"), "project.settings", accelerator("project.settings"))
      ]
    },
    {
      label: t("menu.edit"),
      submenu: [
        commandItem(t("menu.undo"), "edit.undo", accelerator("edit.undo")),
        commandItem(t("menu.redo"), "edit.redo", accelerator("edit.redo")),
        { type: "separator" },
        commandItem(t("menu.cut"), "edit.cut", accelerator("edit.cut")),
        commandItem(t("menu.copy"), "edit.copy", accelerator("edit.copy")),
        commandItem(t("menu.paste"), "edit.paste", accelerator("edit.paste")),
        commandItem(t("menu.selectAll"), "edit.select-all", accelerator("edit.select-all")),
        { type: "separator" },
        commandItem(
          t("menu.splitAtPlayhead"),
          "edit.split-at-playhead",
          accelerator("edit.split-at-playhead")
        )
      ]
    },
    {
      label: t("menu.view"),
      submenu: [
        commandItem(
          t("menu.toggleFullScreen"),
          "view.toggle-full-screen",
          accelerator("view.toggle-full-screen")
        )
      ]
    },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        commandItem(
          t("menu.audioBenchmark"),
          "help.audio-benchmark",
          accelerator("help.audio-benchmark")
        ),
        commandItem(
          t("menu.effectChainGraph"),
          "help.effect-chain-graph",
          accelerator("help.effect-chain-graph")
        )
      ]
    }
  ]
}

export function installApplicationMenu(
  platform: NodeJS.Platform = process.platform,
  shortcuts: ShortcutPreferences = { keyboard: {}, midi: {} }
): void {
  if (platform !== "darwin") {
    Menu.setApplicationMenu(null)
    return
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(macApplicationMenu(shortcuts)))
}

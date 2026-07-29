import { dialog, ipcMain } from "electron"
import { IPC_CHANNELS } from "@yadaw/contracts"
import type { MidiImportPlan } from "@yadaw/contracts"
import type { IpcHandlerContext } from "./context"
import { t } from "../i18n"
import { assertTrustedSender } from "./support"
export function registerMidiHandlers(context: IpcHandlerContext): void {
  const { midiImport, lifecycle, projects } = context
  ipcMain.handle(IPC_CHANNELS.midiImportPrepare, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.assertProjectWriteAllowed()
    let path = typeof value === "string" && value.trim() ? value : undefined
    if (!path) {
      const result = await dialog.showOpenDialog({
        title: t("dialog.importMidi.title"),
        properties: ["openFile"],
        filters: [{ name: t("dialog.importMidi.filter"), extensions: ["mid", "midi"] }]
      })
      path = result.filePaths[0]
      if (result.canceled || !path) return null
    }
    return midiImport.prepare(path)
  })

  ipcMain.handle(IPC_CHANNELS.midiImportCommit, async (event, value: unknown) => {
    assertTrustedSender(event)
    lifecycle.assertProjectWriteAllowed()
    if (typeof value !== "object" || value === null) {
      throw new TypeError("MIDI import plan must be an object")
    }
    const result = await midiImport.commit(value as MidiImportPlan)
    lifecycle.syncProject(projects.current)
    return result
  })
}

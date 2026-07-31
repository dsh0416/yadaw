import { acceptHMRUpdate, defineStore } from "pinia"
import type {
  ApplicationCommandId,
  ApplicationWindowCommandId,
  DesktopPlatform
} from "@yadaw/contracts"
import { mutationMeta } from "../rpc"
import { useProjectStore } from "./project"

export const useApplicationWindowStore = defineStore("application-window", () => {
  const projectStore = useProjectStore()
  const platform: DesktopPlatform = window.yadaw.platform

  function subscribeCommands(listener: (command: ApplicationCommandId) => void): () => void {
    return window.yadaw.subscribeApplicationCommands((event) => listener(event.payload))
  }

  async function execute(command: ApplicationWindowCommandId): Promise<void> {
    const target = projectStore.desktopSession
    if (!target) return
    await window.yadaw.executeApplicationWindowCommand(
      mutationMeta(target, `application-window-${command}`),
      command
    )
  }

  async function setTheme(theme: "light" | "dark"): Promise<void> {
    const target = projectStore.desktopSession
    if (!target) return
    await window.yadaw.setApplicationWindowTheme(
      mutationMeta(target, "application-window-theme"),
      theme
    )
  }

  return { platform, subscribeCommands, execute, setTheme }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useApplicationWindowStore, import.meta.hot))
}

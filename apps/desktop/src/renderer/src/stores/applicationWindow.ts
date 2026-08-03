import { acceptHMRUpdate, defineStore } from "pinia"
import type {
  ApplicationCommandId,
  ApplicationWindowCommandId,
  DesktopPlatform
} from "@heron/contracts"
import { mutationMeta } from "../rpc"
import { useProjectStore } from "./project"

export const useApplicationWindowStore = defineStore("application-window", () => {
  const projectStore = useProjectStore()
  const platform: DesktopPlatform = window.heron.platform

  function subscribeCommands(listener: (command: ApplicationCommandId) => void): () => void {
    return window.heron.subscribeApplicationCommands((event) => listener(event.payload))
  }

  async function execute(command: ApplicationWindowCommandId): Promise<void> {
    const target = projectStore.desktopSession
    if (!target) return
    await window.heron.executeApplicationWindowCommand(
      mutationMeta(target, `application-window-${command}`),
      command
    )
  }

  async function setTheme(theme: "light" | "dark"): Promise<void> {
    const target = projectStore.desktopSession
    if (!target) return
    await window.heron.setApplicationWindowTheme(
      mutationMeta(target, "application-window-theme"),
      theme
    )
  }

  return { platform, subscribeCommands, execute, setTheme }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useApplicationWindowStore, import.meta.hot))
}

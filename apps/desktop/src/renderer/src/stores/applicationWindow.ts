import { acceptHMRUpdate, defineStore } from "pinia"
import type {
  ApplicationCommandId,
  ApplicationWindowCommandId,
  DesktopPlatform
} from "@yadaw/contracts"

export const useApplicationWindowStore = defineStore("application-window", () => {
  const platform: DesktopPlatform = window.yadaw.platform

  function subscribeCommands(listener: (command: ApplicationCommandId) => void): () => void {
    return window.yadaw.subscribeApplicationCommands(listener)
  }

  function execute(command: ApplicationWindowCommandId): Promise<void> {
    return window.yadaw.executeApplicationWindowCommand(command)
  }

  function setTheme(theme: "light" | "dark"): Promise<void> {
    return window.yadaw.setApplicationWindowTheme(theme)
  }

  return { platform, subscribeCommands, execute, setTheme }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useApplicationWindowStore, import.meta.hot))
}

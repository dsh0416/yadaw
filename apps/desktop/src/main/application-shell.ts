export const APPLICATION_ID = "dev.yadaw.studio"
export const APPLICATION_NAME = "YADAW"

interface ApplicationIdentity {
  commandLine: {
    appendSwitch(name: string, value?: string): void
  }
  setAppUserModelId(id: string): void
  setName(name: string): void
}

interface ApplicationLifecycle {
  on(event: "window-all-closed", listener: () => void): unknown
  quit(): void
}

export function configureApplicationIdentity(
  application: ApplicationIdentity,
  platform: NodeJS.Platform
): void {
  application.setName(APPLICATION_NAME)

  if (platform === "win32") {
    application.setAppUserModelId(APPLICATION_ID)
  } else if (platform === "linux") {
    application.commandLine.appendSwitch("class", APPLICATION_ID)
  }
}

export function quitWhenAllWindowsAreClosed(application: ApplicationLifecycle): void {
  application.on("window-all-closed", () => application.quit())
}

import { app } from "electron"
import { AudioHostService } from "./audio-host-service"
import { deferProjectClose } from "./dirty-project-close"
import { ProjectService } from "./project-service"
import { startApplication } from "./startup"
import { mainWindow } from "./windows"

const APPLICATION_ID = "dev.yadaw.studio"

if (process.platform === "win32") {
  app.setAppUserModelId(APPLICATION_ID)
} else if (process.platform === "linux") {
  app.commandLine.appendSwitch("class", APPLICATION_ID)
}

if (process.env.YADAW_TEST_USER_DATA) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch("disable-gpu")
  app.setPath("userData", process.env.YADAW_TEST_USER_DATA)
}

let projectService: ProjectService | null = null
let audioHostService: AudioHostService | null = null
let shutdownComplete = false
let shutdownPromise: Promise<void> | null = null

async function shutdownServices(): Promise<void> {
  await Promise.allSettled([
    (async () => {
      const service = audioHostService
      if (!service) return
      try {
        await service.stopAudioEngine()
      } catch {
        // The helper may already be stopping or unavailable.
      }
      await service.stop()
    })(),
    projectService?.shutdown()
  ])
}

startApplication(
  () => shutdownPromise !== null,
  (services) => {
    audioHostService = services.audioHostService
    projectService = services.projectService
  }
)

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit()
  }
})

app.on("before-quit", (event) => {
  if (shutdownComplete) return
  if (
    deferProjectClose({
      command: "application.quit",
      event,
      project: projectService?.current ?? null,
      window: mainWindow
    })
  ) {
    return
  }
  event.preventDefault()
  if (shutdownPromise) return
  shutdownPromise = shutdownServices().finally(() => {
    shutdownComplete = true
    app.quit()
  })
})

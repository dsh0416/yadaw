import { app } from "electron"
import { configureApplicationIdentity, quitWhenAllWindowsAreClosed } from "./application-shell"
import { AudioHostService } from "./audio-host-service"
import { deferProjectClose } from "./dirty-project-close"
import { ProjectService } from "./project-service"
import { startApplication } from "./startup"
import { mainWindow } from "./windows"

configureApplicationIdentity(app, process.platform)
quitWhenAllWindowsAreClosed(app)

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

import { app } from "electron"
import {
  configureApplicationIdentity,
  deferProjectClose,
  quitWhenAllWindowsAreClosed,
  registerRendererScheme
} from "./app"
import { AudioHostService } from "./audio-host"
import { ProjectService } from "./project"
import { startApplication, type StartedApplicationServices } from "./app"
import { mainWindow } from "./app"

configureApplicationIdentity(app, process.platform)
registerRendererScheme()
quitWhenAllWindowsAreClosed(app)

if (process.env.HERON_TEST_USER_DATA) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch("disable-gpu")
  app.setPath("userData", process.env.HERON_TEST_USER_DATA)
}

let projectService: ProjectService | null = null
let audioHostService: AudioHostService | null = null
let startedApplicationServices: StartedApplicationServices | null = null
let shutdownComplete = false
let shutdownPromise: Promise<void> | null = null

async function shutdownServices(): Promise<void> {
  startedApplicationServices?.dispose()
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
    startedApplicationServices = services
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

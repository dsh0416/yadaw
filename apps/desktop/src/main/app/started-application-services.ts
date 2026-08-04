import type { AudioHostService } from "../audio-host"
import type { ProjectService } from "../project"

export interface ApplicationDisposable {
  dispose(): void
}

export interface StartedApplicationServices extends ApplicationDisposable {
  audioHostService: AudioHostService
  projectService: ProjectService
}

export function createStartedApplicationServices(
  audioHostService: AudioHostService,
  projectService: ProjectService,
  registrations: readonly ApplicationDisposable[]
): StartedApplicationServices {
  let disposed = false
  return {
    audioHostService,
    projectService,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const registration of registrations) registration.dispose()
    }
  }
}

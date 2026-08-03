import type { LifecycleCoordinator } from "./lifecycle-coordinator"
import type { ProjectService } from "./project-service"

type ExternalProjectState = Pick<ProjectService, "current" | "markExternalStateDirty">
type ProjectLifecycleProjection = Pick<LifecycleCoordinator, "syncProject">

export async function commitExternalProjectDirty(
  projects: ExternalProjectState,
  lifecycle: ProjectLifecycleProjection
): Promise<void> {
  const changed = await projects.markExternalStateDirty()
  if (!changed) return
  lifecycle.syncProject(projects.current)
}

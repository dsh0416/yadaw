export class ProjectWorkspaceOwnership<T> {
  private activeWorkspace: T | null = null
  private candidateWorkspace: T | null = null

  get active(): T | null {
    return this.activeWorkspace
  }

  get candidate(): T | null {
    return this.candidateWorkspace
  }

  requireActive(): T {
    if (!this.activeWorkspace) throw new Error("No project is open")
    return this.activeWorkspace
  }

  requireCandidate(): T {
    if (!this.candidateWorkspace) throw new Error("No project candidate is prepared")
    return this.candidateWorkspace
  }

  stage(candidate: T): void {
    if (this.activeWorkspace) throw new Error("Close the current project before opening another")
    if (this.candidateWorkspace) throw new Error("A project candidate is already being prepared")
    this.candidateWorkspace = candidate
  }

  assertCanPrepare(): void {
    if (this.activeWorkspace) throw new Error("Close the current project before opening another")
    if (this.candidateWorkspace) throw new Error("A project candidate is already being prepared")
  }

  commitCandidate(): T {
    const candidate = this.requireCandidate()
    this.activeWorkspace = candidate
    this.candidateWorkspace = null
    return candidate
  }

  takeCandidate(): T | null {
    const candidate = this.candidateWorkspace
    this.candidateWorkspace = null
    return candidate
  }

  takeActive(): T | null {
    const active = this.activeWorkspace
    this.activeWorkspace = null
    return active
  }

  drain(): T[] {
    const workspaces = [this.candidateWorkspace, this.activeWorkspace].filter(
      (workspace): workspace is T => workspace !== null
    )
    this.candidateWorkspace = null
    this.activeWorkspace = null
    return workspaces
  }
}

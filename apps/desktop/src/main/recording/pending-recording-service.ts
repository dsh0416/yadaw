import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import type { PendingRecording } from "@heron/contracts"
import type { ProjectService } from "../project"
import type { ApplicationSettingsStore } from "../settings"
import { RecordingCommitter } from "./recording-committer"
import { toPendingRecording, type RecordingSidecar } from "./recording-contracts"
import { RecordingRecoveryRepository } from "./recording-recovery-repository"

export class PendingRecordingService {
  constructor(
    private readonly settings: ApplicationSettingsStore,
    private readonly projects: ProjectService,
    private readonly recovery: RecordingRecoveryRepository,
    private readonly committer: RecordingCommitter
  ) {}

  async listPending(): Promise<PendingRecording[]> {
    const applicationSettings = await this.settings.get()
    const pending: PendingRecording[] = []
    for (const sidecar of await this.recovery.list<RecordingSidecar>(
      applicationSettings.swapDirectory
    )) {
      try {
        if (this.projects.current?.path === sidecar.projectPath) {
          sidecar.assetExists = await this.committer.isCommitted(sidecar)
        }
        pending.push(toPendingRecording(sidecar))
      } catch {
        // A malformed sidecar is left on disk for explicit manual inspection.
      }
    }
    return pending.sort((a, b) => b.startedAt - a.startedAt)
  }

  private async readSidecar(id: string): Promise<RecordingSidecar> {
    const settings = await this.settings.get()
    return this.recovery.read<RecordingSidecar>(settings.swapDirectory, id)
  }

  async recover(id: string): Promise<PendingRecording> {
    const recording = await this.readSidecar(id)
    if (
      recording.assetExists ||
      recording.state === "committed" ||
      (await this.committer.isCommitted(recording))
    )
      return toPendingRecording(recording)
    await this.committer.recover(recording)
    return toPendingRecording(recording)
  }

  async deletePending(id: string): Promise<void> {
    const recording = await this.readSidecar(id)
    await this.recovery.remove(recording)
  }

  async cleanupCommittedForProject(projectPath: string): Promise<void> {
    const settings = await this.settings.get()
    const files = await readdir(settings.swapDirectory).catch(() => [] as string[])
    for (const file of files.filter((name) => name.endsWith(".recording.json"))) {
      try {
        const sidecar = JSON.parse(
          await readFile(join(settings.swapDirectory, file), "utf8")
        ) as RecordingSidecar
        if (sidecar.projectPath !== projectPath) continue
        let assetExists = sidecar.state === "committed"
        if (!assetExists && this.projects.current?.path === projectPath) {
          assetExists = await this.committer.isCommitted(sidecar)
        }
        if (assetExists) {
          await this.deletePending(sidecar.id)
        }
      } catch {
        // Keep any recording whose state cannot be proven safe to delete.
      }
    }
  }
}

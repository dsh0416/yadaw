import { AudioHostIpcClient } from "@heron/audio-host-client"
import type { AudioHostRuntimePreferences } from "@heron/contracts"

export class AudioHostProcessSupervisor {
  client: AudioHostIpcClient | null = null
  restartBudget = 1
  stopping = false

  constructor(
    private readonly executablePath: string,
    private readonly crashMarkerPath: string,
    private readonly editorOwnerWindowHandle: Buffer | undefined
  ) {}

  launch(preferences: AudioHostRuntimePreferences): AudioHostIpcClient {
    const client = new AudioHostIpcClient(
      this.executablePath,
      this.crashMarkerPath,
      preferences.workerThreads === "auto" ? undefined : preferences.workerThreads,
      preferences.maxBlockingThreads === "auto" ? undefined : preferences.maxBlockingThreads,
      preferences.egressConcurrency === "auto" ? undefined : preferences.egressConcurrency,
      this.editorOwnerWindowHandle
    )
    this.client = client
    return client
  }

  detach(client: AudioHostIpcClient): boolean {
    if (this.client !== client) return false
    this.client = null
    return true
  }

  canRestart(): boolean {
    return !this.stopping && this.restartBudget > 0
  }

  consumeRestart(): void {
    this.restartBudget -= 1
  }
}

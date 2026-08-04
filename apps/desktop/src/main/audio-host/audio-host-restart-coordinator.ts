import type {
  AudioHostRuntimePreferences,
  AudioPreferences,
  TransportSnapshot
} from "@heron/contracts"

export interface AudioHostRestartState {
  audioPreferences: AudioPreferences | null
  transport: TransportSnapshot
  audioEngineWasRunning: boolean
}

export interface AudioHostRestartOperations {
  isStopping(): boolean
  runtimePreferences(): AudioHostRuntimePreferences
  setRuntimePreferences(preferences: AudioHostRuntimePreferences): void
  captureConfigurationState(): Promise<AudioHostRestartState>
  capturePluginStates(): Promise<void>
  prepareConfigurationRestart(state: AudioHostRestartState): Promise<void>
  shutdownCurrentHelper(): Promise<void>
  restart(state: AudioHostRestartState, mode: "recovery" | "configuration"): Promise<void>
  reportFailure(message: string): void
}

export class AudioHostRestartCoordinator {
  private recovery: Promise<void> | null = null
  private reconfiguring = false
  private restartBudget = 1

  constructor(private readonly operations: AudioHostRestartOperations) {}

  get recoveryPromise(): Promise<void> | null {
    return this.recovery
  }

  get busy(): boolean {
    return this.reconfiguring || this.recovery !== null
  }

  markStable(): void {
    this.restartBudget = 1
  }

  recover(state: AudioHostRestartState): void {
    if (
      this.operations.isStopping() ||
      this.reconfiguring ||
      this.recovery ||
      this.restartBudget <= 0
    ) {
      return
    }
    this.restartBudget -= 1
    const restart = this.operations.restart(state, "recovery")
    const recovery = restart
      .catch((error: unknown) => {
        if (!this.operations.isStopping()) {
          this.operations.reportFailure(`audio helper recovery failed: ${String(error)}`)
        }
      })
      .finally(() => {
        if (this.recovery === recovery) this.recovery = null
      })
    this.recovery = recovery
  }

  async configure(preferences: AudioHostRuntimePreferences): Promise<void> {
    if (this.busy || this.operations.isStopping()) {
      throw new Error("Audio host runtime configuration is busy")
    }
    this.reconfiguring = true
    const previousPreferences = structuredClone(this.operations.runtimePreferences())
    let state: AudioHostRestartState | null = null
    let transactionStarted = false
    try {
      state = await this.operations.captureConfigurationState()
      await this.operations.capturePluginStates()
      transactionStarted = true
      await this.operations.prepareConfigurationRestart(state)
      this.operations.setRuntimePreferences(structuredClone(preferences))
      await this.operations.restart(state, "configuration")
    } catch (error) {
      if (state && transactionStarted) {
        try {
          await this.operations.shutdownCurrentHelper()
          this.operations.setRuntimePreferences(previousPreferences)
          await this.operations.restart(state, "configuration")
        } catch (rollbackError) {
          this.operations.reportFailure(
            `audio runtime configuration and rollback failed: ${String(error)}; ${String(rollbackError)}`
          )
        }
      }
      throw error
    } finally {
      this.reconfiguring = false
    }
  }
}

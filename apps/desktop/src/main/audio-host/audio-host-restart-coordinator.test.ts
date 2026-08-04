import type { AudioHostRuntimePreferences } from "@heron/contracts"
import { describe, expect, it, vi } from "vitest"
import {
  AudioHostRestartCoordinator,
  type AudioHostRestartOperations,
  type AudioHostRestartState
} from "./audio-host-restart-coordinator"

const automatic: AudioHostRuntimePreferences = {
  workerThreads: "auto",
  maxBlockingThreads: "auto",
  egressConcurrency: "auto"
}
const state = {
  audioPreferences: null,
  audioEngineWasRunning: false,
  transport: { state: "stopped", positionFrames: 0, loopEnabled: false, loopRange: null }
} as AudioHostRestartState

function createOperations() {
  let preferences = structuredClone(automatic)
  const operations = {
    isStopping: vi.fn(() => false),
    runtimePreferences: vi.fn(() => structuredClone(preferences)),
    setRuntimePreferences: vi.fn((value: AudioHostRuntimePreferences) => {
      preferences = structuredClone(value)
    }),
    captureConfigurationState: vi.fn(async () => state),
    capturePluginStates: vi.fn(async () => {}),
    prepareConfigurationRestart: vi.fn(async () => {}),
    shutdownCurrentHelper: vi.fn(async () => {}),
    restart: vi.fn(async () => {}),
    reportFailure: vi.fn()
  } satisfies AudioHostRestartOperations
  return { operations, preferences: () => preferences }
}

describe("AudioHostRestartCoordinator", () => {
  it("limits automatic recovery until the helper is stable again", async () => {
    const { operations } = createOperations()
    const coordinator = new AudioHostRestartCoordinator(operations)

    coordinator.recover(state)
    await coordinator.recoveryPromise
    coordinator.recover(state)
    expect(operations.restart).toHaveBeenCalledOnce()

    coordinator.markStable()
    coordinator.recover(state)
    await coordinator.recoveryPromise
    expect(operations.restart).toHaveBeenCalledTimes(2)
  })

  it("rolls configuration back through the operations port", async () => {
    const { operations, preferences } = createOperations()
    operations.restart.mockRejectedValueOnce(new Error("new helper failed")).mockResolvedValueOnce()
    const coordinator = new AudioHostRestartCoordinator(operations)

    await expect(
      coordinator.configure({ workerThreads: 2, maxBlockingThreads: 3, egressConcurrency: 4 })
    ).rejects.toThrow("new helper failed")

    expect(operations.capturePluginStates).toHaveBeenCalledBefore(
      operations.prepareConfigurationRestart
    )
    expect(operations.shutdownCurrentHelper).toHaveBeenCalledOnce()
    expect(operations.restart).toHaveBeenNthCalledWith(2, state, "configuration")
    expect(preferences()).toEqual(automatic)
    expect(coordinator.busy).toBe(false)
  })
})

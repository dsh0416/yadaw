import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { LowLatencyModeSnapshot } from "@heron/contracts"
import { rpcSuccess } from "../test/ipc"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useLowLatencyModeStore } from "./lowLatencyMode"
import { useTransportStore } from "./transport"

const disabled: LowLatencyModeSnapshot = {
  enabled: false,
  targetOutputChannelId: "output-1-2",
  pluginBudgetMs: 5,
  effectiveBudgetSamples: 240,
  bypassedPluginInstanceIds: [],
  unavoidableLatencySamples: 0,
  hasMonitoringPath: false
}

describe("low latency mode store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useAudioRuntimeStore().audioEngineRef = {
      kind: "audio-engine",
      id: "audio-engine",
      epoch: "audio-epoch",
      generation: 1
    }
    useTransportStore().snapshot = {
      state: "stopped",
      positionFrames: 0,
      sampleRate: 48_000,
      loopEnabled: false,
      loopRange: null
    }
  })

  it("waits for the published snapshot before showing the mode as enabled", async () => {
    window.heron.lowLatencyModeSnapshot = vi.fn().mockResolvedValue(rpcSuccess(disabled, 3))
    let release!: (value: ReturnType<typeof rpcSuccess<LowLatencyModeSnapshot>>) => void
    window.heron.configureLowLatencyMode = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        release = resolve
      })
    )
    const store = useLowLatencyModeStore()
    await store.refresh()

    const pending = store.toggle()
    expect(store.applying).toBe(true)
    expect(store.enabled).toBe(false)
    release(rpcSuccess({ ...disabled, enabled: true, hasMonitoringPath: true }, 4))
    await pending

    expect(store.enabled).toBe(true)
    expect(store.resourceRevision).toBe(4)
  })

  it("locks mutations whenever transport is not stopped", () => {
    const store = useLowLatencyModeStore()
    useTransportStore().snapshot = { ...useTransportStore().snapshot, state: "playing" }
    expect(store.canConfigure).toBe(false)
  })
})

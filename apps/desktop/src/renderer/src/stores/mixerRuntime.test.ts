import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MixerRuntimeSnapshot } from "@yadaw/contracts"
import { useMixerRuntimeStore } from "./mixerRuntime"
import { useAudioRuntimeStore } from "./audioRuntime"
import { rpcFailure, rpcSuccess, testBootstrap, TEST_AUDIO_HOST_REF } from "../test/ipc"
import { useProjectStore } from "./project"

const snapshot: MixerRuntimeSnapshot = {
  capturedAt: 42,
  meters: [
    {
      channelId: "audio",
      preFaderPeak: [0.4, 0.2],
      postFaderPeak: [0.5, 0.25],
      heldPeak: [0.75, 0.5],
      clipped: true
    }
  ]
}

const audioEngine = {
  kind: "audio-engine" as const,
  id: "engine",
  epoch: TEST_AUDIO_HOST_REF.epoch,
  generation: 1
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => {
  setActivePinia(createPinia())
  useProjectStore().applyBootstrap(testBootstrap())
  const audioRuntime = useAudioRuntimeStore()
  audioRuntime.applyResources({
    ...testBootstrap().audioResources,
    engine: audioEngine,
    transport: {
      kind: "transport",
      id: "transport",
      epoch: TEST_AUDIO_HOST_REF.epoch,
      generation: 1
    }
  })
})

describe("useMixerRuntimeStore", () => {
  it("selects meters by channel id", () => {
    const store = useMixerRuntimeStore()
    store.runtime = snapshot

    expect(store.meterFor("audio")).toEqual(snapshot.meters[0])
    expect(store.meterFor("missing")).toEqual({
      channelId: "missing",
      preFaderPeak: [0, 0],
      postFaderPeak: [0, 0],
      heldPeak: [0, 0],
      clipped: false
    })
  })

  it("refreshes mixer snapshots from the audio engine resource", async () => {
    const mixerSnapshot = vi.fn(async () => rpcSuccess(snapshot))
    stubApi({ mixerSnapshot })
    const store = useMixerRuntimeStore()

    await store.refresh()

    expect(mixerSnapshot).toHaveBeenCalledTimes(1)
    expect(store.runtime).toEqual(snapshot)
    expect(store.error).toBe("")
  })

  it("records RPC failures during refresh", async () => {
    stubApi({
      mixerSnapshot: vi.fn(async () => rpcFailure("errors.audioEngineUnavailable"))
    })
    const store = useMixerRuntimeStore()

    await store.refresh()

    expect(store.error).not.toBe("")
  })

  it("clears held peaks locally and through the RPC mutation", async () => {
    const clearMixerMeterClips = vi.fn(async () =>
      rpcSuccess({
        ...snapshot,
        meters: snapshot.meters.map((meter) => ({
          ...meter,
          heldPeak: [0, 0],
          clipped: false
        }))
      })
    )
    stubApi({ clearMixerMeterClips })
    const store = useMixerRuntimeStore()
    store.runtime = snapshot

    await store.clearClips()

    expect(clearMixerMeterClips).toHaveBeenCalledTimes(1)
    expect(store.runtime.meters[0]?.heldPeak).toEqual([0, 0])
    expect(store.runtime.meters[0]?.clipped).toBe(false)
  })

  it("resets runtime state and stops polling", () => {
    const store = useMixerRuntimeStore()
    store.runtime = snapshot
    store.error = "stale"
    store.startPolling()

    store.reset()

    expect(store.runtime).toEqual({ meters: [], capturedAt: 0 })
    expect(store.error).toBe("")
  })
})

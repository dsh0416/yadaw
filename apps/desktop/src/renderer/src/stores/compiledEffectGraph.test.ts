import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CompiledAudioGraphSnapshot } from "@yadaw/contracts"
import { useCompiledEffectGraphStore } from "./compiledEffectGraph"
import { rpcFailure, rpcSuccess } from "../test/ipc"
import { useProjectStore } from "./project"

const snapshot: CompiledAudioGraphSnapshot = {
  graphRevision: 3,
  buildGeneration: 5,
  sampleRate: 48_000,
  nodes: [],
  edges: []
}

describe("compiled effect graph store", () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useProjectStore().projectGraphRef = {
      kind: "project-graph",
      id: "project-graph",
      epoch: "project-epoch",
      generation: 1
    }
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it("polls while open without replacing an unchanged published build", async () => {
    window.yadaw.compiledAudioGraphSnapshot = vi
      .fn()
      .mockImplementation(() => Promise.resolve(rpcSuccess(structuredClone(snapshot))))
    const store = useCompiledEffectGraphStore()

    store.open()
    await vi.waitFor(() => expect(store.status).toBe("ready"))
    expect(store.snapshot).toEqual(snapshot)
    const firstReference = store.snapshot

    await vi.advanceTimersByTimeAsync(1_000)
    expect(window.yadaw.compiledAudioGraphSnapshot).toHaveBeenCalledTimes(2)
    expect(store.snapshot).toBe(firstReference)

    store.close()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(window.yadaw.compiledAudioGraphSnapshot).toHaveBeenCalledTimes(2)
  })

  it("distinguishes an unpublished graph from a helper error and can retry", async () => {
    window.yadaw.compiledAudioGraphSnapshot = vi
      .fn()
      .mockResolvedValueOnce(rpcSuccess(null))
      .mockResolvedValueOnce(rpcFailure("errors.audioEngineUnavailable"))
      .mockResolvedValueOnce(rpcSuccess(snapshot))
    const store = useCompiledEffectGraphStore()

    store.open()
    await vi.waitFor(() => expect(store.status).toBe("empty"))
    await store.refresh()
    expect(store.status).toBe("error")
    expect(store.errorMessage).not.toBe("")

    await store.refresh()
    expect(store.status).toBe("ready")
    expect(store.snapshot).toEqual(snapshot)
    store.close()
  })

  it("discards an in-flight result when a newer refresh is queued", async () => {
    let resolveFirst!: (value: ReturnType<typeof rpcSuccess<CompiledAudioGraphSnapshot>>) => void
    const first = new Promise<ReturnType<typeof rpcSuccess<CompiledAudioGraphSnapshot>>>(
      (resolve) => {
        resolveFirst = resolve
      }
    )
    const newer = { ...snapshot, buildGeneration: 6 }
    window.yadaw.compiledAudioGraphSnapshot = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(rpcSuccess(newer))
    const store = useCompiledEffectGraphStore()

    store.open()
    await Promise.resolve()
    void store.refresh()
    resolveFirst(rpcSuccess(snapshot))

    await vi.waitFor(() => expect(store.snapshot).toEqual(newer))
    expect(window.yadaw.compiledAudioGraphSnapshot).toHaveBeenCalledTimes(2)
    store.close()
  })
})

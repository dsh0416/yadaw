import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StartupProgressSnapshot } from "@yadaw/contracts"
import { useStartupStore } from "./startup"

function progress(
  overrides: Partial<StartupProgressSnapshot> = {}
): StartupProgressSnapshot {
  return {
    phase: "loading-catalog",
    progress: 25,
    label: "Loading catalog",
    detail: "Scanning built-in plugins",
    completed: 1,
    total: 4,
    warnings: 0,
    ...overrides
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe("useStartupStore", () => {
  it("ignores backwards progress except for terminal phases", () => {
    let listener: ((event: {
      sourceEpoch: string
      sequence: number
      payload: StartupProgressSnapshot
    }) => void) | null = null
    stubApi({
      subscribeStartupProgress: (callback: typeof listener) => {
        listener = callback
        return () => {
          listener = null
        }
      }
    })
    const store = useStartupStore()
    store.load()
    listener?.({ sourceEpoch: "epoch-1", sequence: 1, payload: progress({ progress: 50 }) })

    listener?.({ sourceEpoch: "epoch-1", sequence: 2, payload: progress({ progress: 40 }) })
    expect(store.progress.progress).toBe(50)

    listener?.({
      sourceEpoch: "epoch-1",
      sequence: 3,
      payload: progress({ phase: "failed", progress: 0 })
    })
    expect(store.progress.phase).toBe("failed")
    expect(store.progress.progress).toBe(0)
  })

  it("deduplicates out-of-order startup events by source epoch and sequence", () => {
    let listener: ((event: {
      sourceEpoch: string
      sequence: number
      payload: StartupProgressSnapshot
    }) => void) | null = null
    stubApi({
      subscribeStartupProgress: (callback: typeof listener) => {
        listener = callback
        return () => undefined
      }
    })
    const store = useStartupStore()
    store.load()
    const first = progress({ progress: 10, label: "First" })
    const second = progress({ progress: 20, label: "Second" })

    listener?.({ sourceEpoch: "epoch-1", sequence: 2, payload: second })
    listener?.({ sourceEpoch: "epoch-1", sequence: 1, payload: first })

    expect(store.progress.label).toBe("Second")

    listener?.({ sourceEpoch: "epoch-2", sequence: 1, payload: progress({ progress: 30, label: "First" }) })
    expect(store.progress.label).toBe("First")
  })

  it("subscribes once and disposes the startup progress listener", () => {
    const unsubscribe = vi.fn()
    const subscribeStartupProgress = vi.fn(() => unsubscribe)
    stubApi({ subscribeStartupProgress })
    const store = useStartupStore()

    store.load()
    store.load()
    store.dispose()

    expect(subscribeStartupProgress).toHaveBeenCalledTimes(1)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })
})

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

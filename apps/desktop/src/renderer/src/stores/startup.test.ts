import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { RpcEvent, StartupProgressSnapshot } from "@heron/contracts"
import { useStartupStore } from "./startup"
import { rpcEvent } from "../test/ipc"

function progress(overrides: Partial<StartupProgressSnapshot> = {}): StartupProgressSnapshot {
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
    const listeners: Array<(event: RpcEvent<StartupProgressSnapshot>) => void> = []
    stubApi({
      subscribeStartupProgress: (callback: (event: RpcEvent<StartupProgressSnapshot>) => void) => {
        listeners.push(callback)
        return () => {
          listeners.length = 0
        }
      }
    })
    const store = useStartupStore()
    store.load()
    listeners[0]?.(rpcEvent(progress({ progress: 50 }), 1, "epoch-1"))

    listeners[0]?.(rpcEvent(progress({ progress: 40 }), 2, "epoch-1"))
    expect(store.progress.progress).toBe(50)

    listeners[0]?.(rpcEvent(progress({ phase: "failed", progress: 0 }), 3, "epoch-1"))
    expect(store.progress.phase).toBe("failed")
    expect(store.progress.progress).toBe(0)
  })

  it("deduplicates out-of-order startup events by source epoch and sequence", () => {
    const listeners: Array<(event: RpcEvent<StartupProgressSnapshot>) => void> = []
    stubApi({
      subscribeStartupProgress: (callback: (event: RpcEvent<StartupProgressSnapshot>) => void) => {
        listeners.push(callback)
        return () => undefined
      }
    })
    const store = useStartupStore()
    store.load()
    const first = progress({ progress: 10, label: "First" })
    const second = progress({ progress: 20, label: "Second" })

    listeners[0]?.(rpcEvent(second, 2, "epoch-1"))
    listeners[0]?.(rpcEvent(first, 1, "epoch-1"))

    expect(store.progress.label).toBe("Second")

    listeners[0]?.(rpcEvent(progress({ progress: 30, label: "First" }), 1, "epoch-2"))
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
  Object.assign(window.heronSplash as unknown as Record<string, unknown>, overrides)
}

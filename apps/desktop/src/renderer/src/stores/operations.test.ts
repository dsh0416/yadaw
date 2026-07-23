import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useOperationStore } from "./operations"
import type { OperationSnapshot } from "@yadaw/contracts"

const running: OperationSnapshot = {
  id: "one",
  title: "Import audio",
  phase: "writing-large-object",
  state: "running",
  completedBytes: 5,
  totalBytes: 10,
  cancellable: true,
  message: null,
  dropoutFrames: 0
}

describe("operation store", () => {
  beforeEach(() => {
    vi.useRealTimers()
    setActivePinia(createPinia())
  })

  it("automatically removes successful completed work", () => {
    vi.useFakeTimers()
    const store = useOperationStore()
    store.apply({ type: "upsert", operation: running })
    expect(store.active?.phase).toBe("writing-large-object")
    store.apply({ type: "upsert", operation: { ...running, state: "completed", phase: "committing-database" } })
    expect(store.operations).toHaveLength(1)
    vi.advanceTimersByTime(750)
    expect(store.operations).toHaveLength(0)
  })

  it("keeps failures and dropout warnings until explicitly dismissed", () => {
    vi.useFakeTimers()
    const store = useOperationStore()
    store.apply({ type: "upsert", operation: { ...running, state: "completed", dropoutFrames: 8 } })
    vi.advanceTimersByTime(5_000)
    expect(store.operations).toHaveLength(1)
    store.dismiss("one")
    expect(store.operations).toHaveLength(0)
  })

  it("delegates cancellation only through the public desktop API", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    window.yadaw.cancelOperation = cancel
    const store = useOperationStore()
    await store.cancel("one")
    expect(cancel).toHaveBeenCalledWith("one")
  })
})

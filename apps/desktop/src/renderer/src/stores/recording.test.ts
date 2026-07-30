import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PendingRecording, RecordingSession } from "@yadaw/contracts"
import { useRecordingStore } from "./recording"

function session(overrides: Partial<RecordingSession> = {}): RecordingSession {
  return {
    id: "take-1",
    startedAt: 1_000,
    swapPath: "/swap/take-1.bwf",
    startFrame: 480,
    trackIds: ["audio-1"],
    ...overrides
  }
}

function pendingRecording(id: string): PendingRecording {
  return {
    id,
    state: "ready",
    audioPath: `/swap/${id}.bwf`,
    sidecarPath: `/swap/${id}.json`,
    projectPath: "/projects/demo.yadaw",
    sampleRate: 48_000,
    channels: 2,
    startedAt: 1_000,
    dropoutFrames: 0,
    assetExists: true,
    recordedTracks: []
  }
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => setActivePinia(createPinia()))

describe("derived state", () => {
  it("starts idle with no active session", () => {
    const store = useRecordingStore()

    expect(store.lifecycle.status).toBe("idle")
    expect(store.active).toBeNull()
    expect(store.busy).toBe(false)
    expect(store.error).toBe("")
  })

  it("exposes the session only while one is attached to the lifecycle", () => {
    const store = useRecordingStore()

    store.applyLifecycleState({ status: "recording", session: session(), error: null })
    expect(store.active?.id).toBe("take-1")

    store.applyLifecycleState({ status: "idle", error: null })
    expect(store.active).toBeNull()
  })

  it("treats only idle and recording as non-busy", () => {
    const store = useRecordingStore()
    const busyStates = [
      { status: "starting", error: null },
      { status: "stopping", session: session(), error: null },
      { status: "finalizing", session: session(), error: null },
      { status: "recovering", recordingId: "take-1", error: null }
    ] as const

    store.applyLifecycleState({ status: "recording", session: session(), error: null })
    expect(store.busy).toBe(false)

    for (const state of busyStates) {
      store.applyLifecycleState(state)
      expect(store.busy, state.status).toBe(true)
    }
  })

  it("surfaces the lifecycle error as a string", () => {
    const store = useRecordingStore()

    store.applyLifecycleState({ status: "idle", error: "Disk full" })

    expect(store.error).toBe("Disk full")
  })

  it("copies applied lifecycle state so later mutations cannot leak in", () => {
    const store = useRecordingStore()
    const state = { status: "recording", session: session(), error: null } as const

    store.applyLifecycleState(state)
    state.session.trackIds.push("audio-2")

    expect(store.active?.trackIds).toEqual(["audio-1"])
  })
})

describe("start", () => {
  it("moves to recording and returns the session", async () => {
    stubApi({ startRecording: vi.fn(async () => session()) })
    const store = useRecordingStore()

    await expect(store.start()).resolves.toMatchObject({ id: "take-1" })

    expect(store.lifecycle.status).toBe("recording")
    expect(store.active?.id).toBe("take-1")
  })

  it("refuses to start a second take while one is already running", async () => {
    const startRecording = vi.fn(async () => session())
    stubApi({ startRecording })
    const store = useRecordingStore()
    await store.start()

    await expect(store.start()).resolves.toBeNull()

    expect(startRecording).toHaveBeenCalledTimes(1)
  })

  it("returns to idle and reports why the take could not start", async () => {
    stubApi({
      startRecording: vi.fn(async () => {
        throw new Error("No armed track")
      })
    })
    const store = useRecordingStore()

    await expect(store.start()).resolves.toBeNull()

    expect(store.lifecycle.status).toBe("idle")
    expect(store.error).toBe("No armed track")
  })

  it("uses a generic message for non-Error rejections", async () => {
    stubApi({
      startRecording: vi.fn(async () => {
        throw "boom"
      })
    })
    const store = useRecordingStore()

    await store.start()

    expect(store.error).toBe("Recording failed.")
  })
})

describe("stop", () => {
  it("finishes the take and refreshes the pending list", async () => {
    const completed = pendingRecording("take-1")
    stubApi({
      startRecording: vi.fn(async () => session()),
      stopRecording: vi.fn(async () => completed),
      listPendingRecordings: vi.fn(async () => [completed])
    })
    const store = useRecordingStore()
    await store.start()

    await expect(store.stop()).resolves.toBe(completed)

    expect(store.lifecycle.status).toBe("idle")
    expect(store.pending).toEqual([completed])
  })

  it("does nothing when no take is running", async () => {
    const stopRecording = vi.fn()
    stubApi({ stopRecording })
    const store = useRecordingStore()

    await expect(store.stop()).resolves.toBeNull()

    expect(stopRecording).not.toHaveBeenCalled()
  })

  it("returns to idle and reports a failed stop", async () => {
    stubApi({
      startRecording: vi.fn(async () => session()),
      stopRecording: vi.fn(async () => {
        throw new Error("Swap file is locked")
      })
    })
    const store = useRecordingStore()
    await store.start()

    await expect(store.stop()).resolves.toBeNull()

    expect(store.lifecycle.status).toBe("idle")
    expect(store.error).toBe("Swap file is locked")
  })
})

describe("pending recordings", () => {
  it("loads the pending list from the main process", async () => {
    const recordings = [pendingRecording("take-1"), pendingRecording("take-2")]
    stubApi({ listPendingRecordings: vi.fn(async () => recordings) })
    const store = useRecordingStore()

    await store.refreshPending()

    expect(store.pending).toEqual(recordings)
  })

  it("recovers a take and refreshes the list", async () => {
    const recoverRecording = vi.fn(async () => undefined)
    stubApi({ recoverRecording, listPendingRecordings: vi.fn(async () => []) })
    const store = useRecordingStore()

    await expect(store.recover(pendingRecording("take-1"))).resolves.toBe(true)

    expect(recoverRecording).toHaveBeenCalledWith("take-1")
    expect(store.lifecycle.status).toBe("idle")
    expect(store.pending).toEqual([])
  })

  it("reports a failed recovery and returns to idle", async () => {
    stubApi({
      recoverRecording: vi.fn(async () => {
        throw new Error("Sidecar is corrupt")
      })
    })
    const store = useRecordingStore()

    await expect(store.recover(pendingRecording("take-1"))).resolves.toBe(false)

    expect(store.lifecycle.status).toBe("idle")
    expect(store.error).toBe("Sidecar is corrupt")
  })

  it("uses a generic message when recovery rejects without an Error", async () => {
    stubApi({
      recoverRecording: vi.fn(async () => {
        throw "boom"
      })
    })
    const store = useRecordingStore()

    await store.recover(pendingRecording("take-1"))

    expect(store.error).toBe("Recording recovery failed.")
  })

  it("refuses to recover while another operation is in flight", async () => {
    const recoverRecording = vi.fn()
    stubApi({ startRecording: vi.fn(async () => session()), recoverRecording })
    const store = useRecordingStore()
    await store.start()

    await expect(store.recover(pendingRecording("take-1"))).resolves.toBe(false)

    expect(recoverRecording).not.toHaveBeenCalled()
  })

  it("deletes a take and refreshes the list", async () => {
    const deletePendingRecording = vi.fn(async () => undefined)
    stubApi({ deletePendingRecording, listPendingRecordings: vi.fn(async () => []) })
    const store = useRecordingStore()
    store.pending = [pendingRecording("take-1")]

    await store.remove(pendingRecording("take-1"))

    expect(deletePendingRecording).toHaveBeenCalledWith("take-1")
    expect(store.pending).toEqual([])
  })

  it("refuses to delete while another operation is in flight", async () => {
    const deletePendingRecording = vi.fn()
    stubApi({ startRecording: vi.fn(async () => session()), deletePendingRecording })
    const store = useRecordingStore()
    await store.start()

    await store.remove(pendingRecording("take-1"))

    expect(deletePendingRecording).not.toHaveBeenCalled()
  })
})

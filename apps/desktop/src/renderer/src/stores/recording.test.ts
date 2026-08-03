import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AudioEngineRef,
  PendingRecording,
  ProjectGraphRef,
  ProjectSessionRef,
  ProjectWorkspaceSnapshot,
  RecordingResourceSnapshot,
  RecordingSession,
  RpcResult
} from "@heron/contracts"
import { useAudioRuntimeStore } from "./audioRuntime"
import { useProjectStore } from "./project"
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
    projectPath: "/projects/demo.heron",
    sampleRate: 48_000,
    channels: 2,
    startedAt: 1_000,
    dropoutFrames: 0,
    assetExists: true,
    recordedTracks: []
  }
}

const project: ProjectSessionRef = {
  kind: "project-session",
  id: "project",
  epoch: "main",
  generation: 1
}
const projectGraph: ProjectGraphRef = {
  kind: "project-graph",
  id: "graph",
  epoch: "main",
  generation: 1
}
const audioEngine: AudioEngineRef = {
  kind: "audio-engine",
  id: "engine",
  epoch: "helper",
  generation: 1
}

function recordingResource(overrides: Partial<RecordingResourceSnapshot> = {}) {
  return {
    recording: {
      kind: "recording-session",
      id: "take-1",
      epoch: "main",
      generation: 1
    },
    project,
    projectGraph,
    audioEngine,
    revision: 1,
    session: session(),
    ...overrides
  } satisfies RecordingResourceSnapshot
}

function workspace(): ProjectWorkspaceSnapshot {
  return {
    project,
    projectGraph,
    revision: 2,
    session: {
      id: project.id,
      path: "/projects/demo.heron",
      configuration: {
        name: "Demo",
        sampleRate: 48_000,
        timeSignatureNumerator: 4,
        timeSignatureDenominator: 4,
        waveformDisplayMode: "separate"
      },
      dirty: true,
      recoveredWorkingCopy: false
    },
    graph: {} as ProjectWorkspaceSnapshot["graph"],
    assets: []
  }
}

function success<T>(value: T): RpcResult<T> {
  return {
    ok: true,
    requestId: "request",
    value,
    warnings: []
  }
}

function failure(userMessageKey = "errors.recordingUnavailable"): RpcResult<never> {
  return {
    ok: false,
    requestId: "request",
    error: {
      code: "resource-unavailable",
      category: "unavailable",
      outcome: "not-committed",
      retry: "safe",
      correlationId: "correlation",
      userMessageKey,
      details: {
        type: "resource-unavailable",
        component: "main",
        dispatched: true
      }
    }
  }
}

function configureDependencies(): void {
  const projectStore = useProjectStore()
  projectStore.projectRef = structuredClone(project)
  projectStore.projectGraphRef = structuredClone(projectGraph)
  projectStore.projectRevision = 1
  useAudioRuntimeStore().audioEngineRef = structuredClone(audioEngine)
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.heron as unknown as Record<string, unknown>, overrides)
}

beforeEach(() => {
  setActivePinia(createPinia())
  configureDependencies()
})

describe("derived state", () => {
  it("starts idle with no active session", () => {
    const store = useRecordingStore()

    expect(store.lifecycle.status).toBe("idle")
    expect(store.active).toBeNull()
    expect(store.busy).toBe(false)
    expect(store.error).toBe("")
  })

  it("exposes the session only while a resource projection is attached", () => {
    const store = useRecordingStore()

    store.applyResource(recordingResource())
    expect(store.active?.id).toBe("take-1")

    store.applyResource(null)
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

  it("copies applied resource state so later mutations cannot leak in", () => {
    const store = useRecordingStore()
    const state = recordingResource()

    store.applyResource(state)
    state.session.trackIds.push("audio-2")

    expect(store.active?.trackIds).toEqual(["audio-1"])
  })
})

describe("start", () => {
  it("moves to recording and returns the session", async () => {
    stubApi({ startRecording: vi.fn(async () => success(recordingResource())) })
    const store = useRecordingStore()

    await expect(store.start()).resolves.toMatchObject({ id: "take-1" })

    expect(store.lifecycle.status).toBe("recording")
    expect(store.active?.id).toBe("take-1")
  })

  it("forwards the count-in preference with the recording start request", async () => {
    const startRecording = vi.fn(async () => success(recordingResource()))
    stubApi({ startRecording })
    const store = useRecordingStore()

    await store.start(true)

    expect(startRecording).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        countIn: true
      })
    )
  })

  it("refuses to start a second take while one is already running", async () => {
    const startRecording = vi.fn(async () => success(recordingResource()))
    stubApi({ startRecording })
    const store = useRecordingStore()
    await store.start()

    await expect(store.start()).resolves.toBeNull()

    expect(startRecording).toHaveBeenCalledTimes(1)
  })

  it("returns to idle and reports why the take could not start", async () => {
    stubApi({
      startRecording: vi.fn(async () => failure())
    })
    const store = useRecordingStore()

    await expect(store.start()).resolves.toBeNull()

    expect(store.lifecycle.status).toBe("idle")
    expect(store.error).toBe(
      "Recording is unavailable. Check the project and audio engine, then try again."
    )
  })

  it("uses the typed transport-safe error projection", async () => {
    stubApi({
      startRecording: vi.fn(async () => failure("errors.transportUnavailable"))
    })
    const store = useRecordingStore()

    await store.start()

    expect(store.error).toBe("The IPC transport is unavailable.")
  })
})

describe("stop", () => {
  it("finishes the take and refreshes the pending list", async () => {
    const completed = pendingRecording("take-1")
    stubApi({
      startRecording: vi.fn(async () => success(recordingResource())),
      stopRecording: vi.fn(async () =>
        success({
          recording: recordingResource().recording,
          pending: completed,
          recoverableMedia: true,
          workspace: workspace()
        })
      ),
      listPendingRecordings: vi.fn(async () => success([completed]))
    })
    const store = useRecordingStore()
    await store.start()

    await expect(store.stop()).resolves.toEqual(completed)

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
      startRecording: vi.fn(async () => success(recordingResource())),
      stopRecording: vi.fn(async () => failure("errors.recordingMediaRecoverable"))
    })
    const store = useRecordingStore()
    await store.start()

    await expect(store.stop()).resolves.toBeNull()

    expect(store.lifecycle.status).toBe("idle")
    expect(store.error).toBe(
      "Recording finalization did not complete. The captured media was kept for recovery."
    )
  })
})

describe("pending recordings", () => {
  it("loads the pending list from the main process", async () => {
    const recordings = [pendingRecording("take-1"), pendingRecording("take-2")]
    stubApi({ listPendingRecordings: vi.fn(async () => success(recordings)) })
    const store = useRecordingStore()

    await store.refreshPending()

    expect(store.pending).toEqual(recordings)
  })

  it("recovers a take and refreshes the list", async () => {
    const recovered = pendingRecording("take-1")
    const recoverRecording = vi.fn(async () =>
      success({ pending: recovered, workspace: workspace() })
    )
    stubApi({
      recoverRecording,
      listPendingRecordings: vi.fn(async () => success([]))
    })
    const store = useRecordingStore()

    await expect(store.recover(pendingRecording("take-1"))).resolves.toBe(true)

    expect(recoverRecording).toHaveBeenCalledWith(expect.any(Object), "take-1")
    expect(store.lifecycle.status).toBe("idle")
    expect(store.pending).toEqual([])
  })

  it("reports a failed recovery and returns to idle", async () => {
    stubApi({
      recoverRecording: vi.fn(async () => failure())
    })
    const store = useRecordingStore()

    await expect(store.recover(pendingRecording("take-1"))).resolves.toBe(false)

    expect(store.lifecycle.status).toBe("idle")
    expect(store.error).toBe(
      "Recording is unavailable. Check the project and audio engine, then try again."
    )
  })

  it("uses typed transport errors during recovery", async () => {
    stubApi({
      recoverRecording: vi.fn(async () => failure("errors.transportUnavailable"))
    })
    const store = useRecordingStore()

    await store.recover(pendingRecording("take-1"))

    expect(store.error).toBe("The IPC transport is unavailable.")
  })

  it("refuses to recover while another operation is in flight", async () => {
    const recoverRecording = vi.fn()
    stubApi({ startRecording: vi.fn(async () => success(recordingResource())), recoverRecording })
    const store = useRecordingStore()
    await store.start()

    await expect(store.recover(pendingRecording("take-1"))).resolves.toBe(false)

    expect(recoverRecording).not.toHaveBeenCalled()
  })

  it("deletes a take and refreshes the list", async () => {
    const deletePendingRecording = vi.fn(async () => success(undefined))
    stubApi({
      deletePendingRecording,
      listPendingRecordings: vi.fn(async () => success([]))
    })
    const store = useRecordingStore()
    store.pending = [pendingRecording("take-1")]

    await store.remove(pendingRecording("take-1"))

    expect(deletePendingRecording).toHaveBeenCalledWith(expect.any(Object), "take-1")
    expect(store.pending).toEqual([])
  })

  it("refuses to delete while another operation is in flight", async () => {
    const deletePendingRecording = vi.fn()
    stubApi({
      startRecording: vi.fn(async () => success(recordingResource())),
      deletePendingRecording
    })
    const store = useRecordingStore()
    await store.start()

    await store.remove(pendingRecording("take-1"))

    expect(deletePendingRecording).not.toHaveBeenCalled()
  })
})

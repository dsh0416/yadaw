import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type {
  ApplicationBootstrapSnapshot,
  DesktopSessionRef,
  ProjectSession,
  ProjectWorkspaceSnapshot,
  RpcResult
} from "@yadaw/contracts"
import { useGlobalDialog } from "../composables/useGlobalDialog"
import { useProjectStore } from "./project"

const session: ProjectSession = {
  id: "project",
  path: "session.yadaw",
  configuration: {
    name: "Session",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: true,
  recoveredWorkingCopy: false
}

const workspace: ProjectWorkspaceSnapshot = {
  project: {
    kind: "project-session",
    id: "project",
    epoch: "main-epoch",
    generation: 1
  },
  projectGraph: {
    kind: "project-graph",
    id: "project:graph",
    epoch: "main-epoch",
    generation: 1
  },
  revision: 1,
  session,
  graph: {
    sampleRate: 48_000,
    tracks: [],
    channels: [],
    audioClips: [],
    sends: [],
    plugins: [],
    midiClips: [],
    keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }],
    tempoMap: {
      ticksPerQuarter: 960,
      tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
      timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
    }
  },
  assets: []
}

const desktopSession: DesktopSessionRef = {
  kind: "desktop-session",
  id: "desktop",
  epoch: "main-epoch",
  generation: 1
}

function success<T>(value: T): RpcResult<T> {
  return { ok: true, requestId: "request", value, warnings: [] }
}

function bootstrap(active: ProjectWorkspaceSnapshot | null): ApplicationBootstrapSnapshot {
  return {
    protocolVersion: 2,
    mainEpoch: "main-epoch",
    desktopSession,
    applicationSettings: {
      kind: "application-settings",
      id: "settings",
      epoch: "main-epoch",
      generation: 1
    },
    revision: 1,
    lifecycle: {
      revision: 1,
      project: active
        ? { status: "open", session: active.session, error: null }
        : { status: "closed", error: null },
      audio: {
        status: "stopped",
        runtime: {
          state: "stopped",
          requestedBufferSize: null,
          sampleRate: null,
          inputSampleRate: null,
          outputSampleRate: null,
          inputBufferSize: null,
          outputBufferSize: null,
          ringBufferCapacityFrames: null,
          ringBufferFillFrames: null,
          inputLatencyMs: null,
          outputLatencyMs: null,
          ringBufferLatencyMs: null,
          engineLatencyMs: null,
          estimatedRoundTripLatencyMs: null,
          xruns: 0,
          clockSync: "inactive",
          bufferFallback: false
        },
        error: null
      },
      recording: { status: "idle", error: null }
    },
    settings: {} as ApplicationBootstrapSnapshot["settings"],
    workspace: active
  }
}

describe("project store dialogs", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("asks in Vue before recovering an unsaved working copy", async () => {
    window.yadaw.prepareOpenProject = vi.fn().mockResolvedValue(
      success({
        path: "session.yadaw",
        recoverableWorkingCopy: true
      })
    )
    const recovered = {
      ...workspace,
      session: {
        ...session,
        dirty: false,
        recoveredWorkingCopy: true
      }
    }
    window.yadaw.openProject = vi.fn().mockResolvedValue(success(recovered))
    const store = useProjectStore()
    store.applyDesktopSession(desktopSession)
    const { activeDialog, selectDialogAction } = useGlobalDialog()

    const opening = store.open("session.yadaw")
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Recover unsaved project?"))
    selectDialogAction("recover")

    await expect(opening).resolves.toMatchObject({
      session: { recoveredWorkingCopy: true },
      graph: { sampleRate: 48_000 }
    })
    expect(window.yadaw.openProject).toHaveBeenCalledWith(
      expect.objectContaining({ target: desktopSession, mutation: expect.any(Object) }),
      "session.yadaw",
      true
    )
    expect(store.session?.recoveredWorkingCopy).toBe(true)
  })

  it("reports archive open failures without a legacy compatibility branch", async () => {
    window.yadaw.prepareOpenProject = vi.fn().mockResolvedValue(
      success({
        path: "future.yadaw",
        recoverableWorkingCopy: false
      })
    )
    window.yadaw.openProject = vi.fn().mockResolvedValue({
      ok: false,
      requestId: "request",
      error: {
        code: "resource-unavailable",
        category: "unavailable",
        outcome: "not-committed",
        retry: "safe",
        correlationId: "migration-failed",
        userMessageKey: "errors.projectMigrationTooNew",
        details: {
          type: "resource-unavailable",
          component: "project-worker",
          dispatched: true
        }
      }
    })
    const store = useProjectStore()
    store.applyDesktopSession(desktopSession)
    const { activeDialog } = useGlobalDialog()

    await expect(store.open("future.yadaw")).resolves.toBeNull()
    expect(activeDialog.value).toBeNull()
    expect(store.lifecycle.status).toBe("closed")
    expect(store.error).toBe("resource-unavailable")
  })

  it("passes the selected dirty-project disposition to the native close operation", async () => {
    window.yadaw.closeProject = vi
      .fn()
      .mockResolvedValue(success({ closed: true, snapshot: bootstrap(null) }))
    const store = useProjectStore()
    store.applyBootstrap(bootstrap(workspace))
    const { activeDialog, selectDialogAction } = useGlobalDialog()

    const closing = store.close()
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    selectDialogAction("discard")

    await expect(closing).resolves.toBe(true)
    expect(window.yadaw.closeProject).toHaveBeenCalledWith(
      expect.objectContaining({ target: workspace.project, mutation: expect.any(Object) }),
      "discard"
    )
    expect(store.lifecycle.status).toBe("closed")
  })

  it("keeps a dirty project open when the Vue dialog is cancelled", async () => {
    window.yadaw.closeProject = vi.fn()
    const store = useProjectStore()
    store.applyBootstrap(bootstrap(workspace))
    const { activeDialog, dismissDialog } = useGlobalDialog()

    const closing = store.close()
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    dismissDialog()

    await expect(closing).resolves.toBe(false)
    expect(window.yadaw.closeProject).not.toHaveBeenCalled()
    expect(store.lifecycle.status).toBe("open")
  })

  it("keeps the authoritative project projection when save-before-close fails", async () => {
    window.yadaw.closeProject = vi.fn().mockResolvedValue({
      ok: false,
      requestId: "request",
      operationId: "project-close",
      error: {
        code: "resource-unavailable",
        category: "unavailable",
        outcome: "not-committed",
        retry: "safe",
        correlationId: "archive-save-failed",
        userMessageKey: "errors.projectSaveFailed",
        resource: workspace.project,
        details: {
          type: "resource-unavailable",
          component: "project-worker",
          dispatched: true
        }
      }
    })
    const store = useProjectStore()
    store.applyBootstrap(bootstrap(workspace))
    const { activeDialog, selectDialogAction } = useGlobalDialog()

    const closing = store.close()
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    selectDialogAction("save")

    await expect(closing).resolves.toBe(false)
    expect(window.yadaw.closeProject).toHaveBeenCalledWith(
      expect.objectContaining({ target: workspace.project, mutation: expect.any(Object) }),
      "save"
    )
    expect(store.lifecycle).toMatchObject({
      status: "open",
      session: { id: session.id, dirty: true }
    })
    expect(store.projectRef).toEqual(workspace.project)
    expect(store.error).toBe("resource-unavailable")
  })

  it("prompts for a pending mutation and waits for its commit before closing", async () => {
    window.yadaw.closeProject = vi
      .fn()
      .mockResolvedValue(success({ closed: true, snapshot: bootstrap(null) }))
    const store = useProjectStore()
    store.applyBootstrap(
      bootstrap({
        ...workspace,
        session: { ...workspace.session, dirty: false }
      })
    )
    const finishMutation = store.beginProjectMutation()
    const { activeDialog, selectDialogAction } = useGlobalDialog()

    const closing = store.close()
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    expect(store.hasUnsavedChanges).toBe(true)
    selectDialogAction("save")
    await Promise.resolve()
    expect(window.yadaw.closeProject).not.toHaveBeenCalled()

    finishMutation()

    await expect(closing).resolves.toBe(true)
    expect(window.yadaw.closeProject).toHaveBeenCalledWith(
      expect.objectContaining({ target: workspace.project, mutation: expect.any(Object) }),
      "save"
    )
  })

  it("coalesces repeated close requests into one dirty-project decision", async () => {
    window.yadaw.closeProject = vi
      .fn()
      .mockResolvedValue(success({ closed: true, snapshot: bootstrap(null) }))
    const store = useProjectStore()
    store.applyBootstrap(bootstrap(workspace))
    const { activeDialog, selectDialogAction } = useGlobalDialog()

    const firstClosing = store.close()
    const secondClosing = store.close()
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    selectDialogAction("discard")

    await expect(Promise.all([firstClosing, secondClosing])).resolves.toEqual([true, true])
    expect(window.yadaw.closeProject).toHaveBeenCalledOnce()
  })
})

import { beforeEach, describe, expect, it, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import type { ProjectSession } from "@yadaw/contracts"
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

describe("project store dialogs", () => {
  beforeEach(() => setActivePinia(createPinia()))

  it("asks in Vue before recovering an unsaved working copy", async () => {
    window.yadaw.prepareOpenProject = vi.fn().mockResolvedValue({
      path: "session.yadaw",
      recoverableWorkingCopy: true
    })
    window.yadaw.openProject = vi.fn().mockResolvedValue({
      ...session,
      dirty: false,
      recoveredWorkingCopy: true
    })
    window.yadaw.listProjectAssets = vi.fn().mockResolvedValue([])
    const store = useProjectStore()
    const { activeDialog, selectDialogAction } = useGlobalDialog()

    const opening = store.open("session.yadaw")
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Recover unsaved project?"))
    selectDialogAction("recover")

    await expect(opening).resolves.toBe(true)
    expect(window.yadaw.openProject).toHaveBeenCalledWith("session.yadaw", true)
    expect(store.session?.recoveredWorkingCopy).toBe(true)
  })

  it("reports archive open failures without a legacy compatibility branch", async () => {
    window.yadaw.prepareOpenProject = vi.fn().mockResolvedValue({
      path: "future.yadaw",
      recoverableWorkingCopy: false
    })
    window.yadaw.openProject = vi
      .fn()
      .mockRejectedValue(new Error("Project contains migrations newer than this application"))
    const store = useProjectStore()
    const { activeDialog } = useGlobalDialog()

    await expect(store.open("future.yadaw")).resolves.toBe(false)
    expect(activeDialog.value).toBeNull()
    expect(store.lifecycle.status).toBe("closed")
    expect(store.error).toContain("migrations newer")
  })

  it("passes the selected dirty-project disposition to the native close operation", async () => {
    window.yadaw.closeProject = vi.fn().mockResolvedValue(true)
    const store = useProjectStore()
    store.applyLifecycleState({ status: "open", session, error: null })
    const { activeDialog, selectDialogAction } = useGlobalDialog()

    const closing = store.close()
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    selectDialogAction("discard")

    await expect(closing).resolves.toBe(true)
    expect(window.yadaw.closeProject).toHaveBeenCalledWith("discard")
    expect(store.lifecycle.status).toBe("closed")
  })

  it("keeps a dirty project open when the Vue dialog is cancelled", async () => {
    window.yadaw.closeProject = vi.fn()
    const store = useProjectStore()
    store.applyLifecycleState({ status: "open", session, error: null })
    const { activeDialog, dismissDialog } = useGlobalDialog()

    const closing = store.close()
    await vi.waitFor(() => expect(activeDialog.value?.title).toBe("Save project before closing?"))
    dismissDialog()

    await expect(closing).resolves.toBe(false)
    expect(window.yadaw.closeProject).not.toHaveBeenCalled()
    expect(store.lifecycle.status).toBe("open")
  })
})

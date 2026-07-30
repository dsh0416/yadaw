import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import type {
  CreateProjectRequest,
  ProjectAssetSummary,
  ProjectConfiguration,
  ProjectLifecycleState,
  ProjectSession,
  ProjectWorkspaceSnapshot
} from "@yadaw/contracts"
import { useGlobalDialog } from "../composables/useGlobalDialog"
import { i18n } from "../i18n"

function t(key: string, params?: Record<string, string | number>): string {
  return i18n.global.t(key, params ?? {})
}

function openState(session: ProjectSession, error: string | null = null): ProjectLifecycleState {
  return { status: "open", session: structuredClone(session), error }
}

export const useProjectStore = defineStore("project", () => {
  const { showDialog } = useGlobalDialog()
  const lifecycle = shallowRef<ProjectLifecycleState>({ status: "closed", error: null })
  const projectAssets = ref<ProjectAssetSummary[]>([])
  let pendingClose: Promise<boolean> | null = null

  const session = computed(() => ("session" in lifecycle.value ? lifecycle.value.session : null))
  const busy = computed(
    () =>
      lifecycle.value.status === "creating" ||
      lifecycle.value.status === "opening" ||
      lifecycle.value.status === "saving" ||
      lifecycle.value.status === "closing"
  )
  const error = computed(() => lifecycle.value.error ?? "")
  const isOpen = computed(() => session.value !== null)

  function applyLifecycleState(state: ProjectLifecycleState): void {
    lifecycle.value = structuredClone(state)
    if (state.status === "closed") projectAssets.value = []
  }

  async function create(request: CreateProjectRequest): Promise<ProjectWorkspaceSnapshot | null> {
    if (lifecycle.value.status !== "closed") return null
    lifecycle.value = { status: "creating", error: null }
    try {
      const workspace = await window.yadaw.createProject(request)
      lifecycle.value = openState(workspace.session)
      projectAssets.value = structuredClone(workspace.assets)
      return workspace
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("errors.unableToCreateProject")
      lifecycle.value = {
        status: "closed",
        error: /cancelled/i.test(message) ? null : message
      }
      return null
    }
  }

  async function open(path?: string): Promise<ProjectWorkspaceSnapshot | null> {
    if (lifecycle.value.status !== "closed") return null
    lifecycle.value = { status: "opening", error: null }
    try {
      const preparation = await window.yadaw.prepareOpenProject(path)
      if (!preparation) {
        lifecycle.value = { status: "closed", error: null }
        return null
      }
      let recover = false
      if (preparation.recoverableWorkingCopy) {
        const choice = await showDialog({
          eyebrow: t("dialog.projectRecovery.eyebrow"),
          tone: "warning",
          title: t("dialog.projectRecovery.title"),
          description: t("dialog.projectRecovery.description"),
          detail: t("dialog.projectRecovery.detail"),
          actions: [
            { value: "recover", label: t("dialog.projectRecovery.recover"), kind: "primary" },
            { value: "saved", label: t("dialog.projectRecovery.openSaved"), kind: "secondary" },
            { value: "cancel", label: t("dialog.actions.cancel"), kind: "cancel" }
          ],
          cancelValue: "cancel"
        })
        if (!choice || choice === "cancel") {
          lifecycle.value = { status: "closed", error: null }
          return null
        }
        recover = choice === "recover"
      }
      const workspace = await window.yadaw.openProject(preparation.path, recover)
      lifecycle.value = openState(workspace.session)
      projectAssets.value = structuredClone(workspace.assets)
      return workspace
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : t("errors.unableToOpenProject")
      lifecycle.value = {
        status: "closed",
        error: message
      }
      return null
    }
  }

  async function save(): Promise<void> {
    if (lifecycle.value.status !== "open") return
    const previous = lifecycle.value.session
    lifecycle.value = { status: "saving", session: structuredClone(previous), error: null }
    try {
      const saved = await window.yadaw.saveProject()
      lifecycle.value = openState(saved ?? previous)
    } catch (reason) {
      lifecycle.value = openState(
        previous,
        reason instanceof Error ? reason.message : t("errors.unableToSaveProject")
      )
    }
  }

  async function closeOnce(disposition?: "save" | "discard" | "cancel"): Promise<boolean> {
    if (lifecycle.value.status === "closed") return true
    if (lifecycle.value.status !== "open") return false
    const previous = lifecycle.value.session
    if (previous.dirty && !disposition) {
      disposition =
        (await showDialog<"save" | "discard" | "cancel">({
          eyebrow: t("dialog.saveBeforeClose.eyebrow"),
          tone: "warning",
          title: t("dialog.saveBeforeClose.title"),
          description: t("dialog.saveBeforeClose.description", {
            name: previous.configuration.name
          }),
          detail: t("dialog.saveBeforeClose.detail"),
          actions: [
            { value: "save", label: t("dialog.saveBeforeClose.save"), kind: "primary" },
            { value: "discard", label: t("dialog.saveBeforeClose.discard"), kind: "secondary" },
            { value: "cancel", label: t("dialog.actions.cancel"), kind: "cancel" }
          ],
          cancelValue: "cancel"
        })) ?? "cancel"
      if (disposition === "cancel") return false
    }
    lifecycle.value = { status: "closing", session: structuredClone(previous), error: null }
    try {
      const closed = await window.yadaw.closeProject(disposition)
      if (!closed) {
        lifecycle.value = openState(previous)
        return false
      }
      lifecycle.value = { status: "closed", error: null }
      projectAssets.value = []
      return true
    } catch (reason) {
      lifecycle.value = openState(
        previous,
        reason instanceof Error ? reason.message : t("errors.unableToCloseProject")
      )
      return false
    }
  }

  async function close(disposition?: "save" | "discard" | "cancel"): Promise<boolean> {
    if (pendingClose) return pendingClose
    const operation = closeOnce(disposition)
    pendingClose = operation
    try {
      return await operation
    } finally {
      if (pendingClose === operation) pendingClose = null
    }
  }

  async function updateConfiguration(configuration: ProjectConfiguration): Promise<void> {
    const updated = await window.yadaw.updateProjectConfiguration(configuration)
    lifecycle.value = openState(updated)
  }

  async function refreshAssets(): Promise<void> {
    if (!session.value) return
    projectAssets.value = await window.yadaw.listProjectAssets()
  }

  function markDirty(): void {
    if (lifecycle.value.status === "open" && !lifecycle.value.session.dirty) {
      lifecycle.value = openState({ ...lifecycle.value.session, dirty: true })
    }
  }

  return {
    lifecycle,
    session,
    projectAssets,
    busy,
    error,
    isOpen,
    applyLifecycleState,
    create,
    open,
    save,
    close,
    updateConfiguration,
    refreshAssets,
    markDirty
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectStore, import.meta.hot))
}

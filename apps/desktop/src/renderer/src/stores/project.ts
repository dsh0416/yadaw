import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import type {
  ApplicationBootstrapSnapshot,
  CreateProjectRequest,
  DesktopSessionRef,
  ProjectAssetSummary,
  ProjectConfiguration,
  ProjectGraphRef,
  ProjectLifecycleState,
  ProjectSession,
  ProjectSessionRef,
  ProjectWorkspaceSnapshot
} from "@yadaw/contracts"
import { useGlobalDialog } from "../composables/useGlobalDialog"
import { i18n } from "../i18n"
import { mutationMeta, readMeta, rpcErrorMessage } from "../rpc"

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
  const desktopSession = shallowRef<DesktopSessionRef | null>(null)
  const projectRef = shallowRef<ProjectSessionRef | null>(null)
  const projectGraphRef = shallowRef<ProjectGraphRef | null>(null)
  const pendingIntent = shallowRef<"create" | "open" | "save" | "close" | null>(null)
  const rpcError = shallowRef("")
  let pendingClose: Promise<boolean> | null = null

  const session = computed(() => ("session" in lifecycle.value ? lifecycle.value.session : null))
  const busy = computed(
    () =>
      pendingIntent.value !== null ||
      lifecycle.value.status === "creating" ||
      lifecycle.value.status === "opening" ||
      lifecycle.value.status === "saving" ||
      lifecycle.value.status === "closing"
  )
  const error = computed(() => rpcError.value || lifecycle.value.error || "")
  const isOpen = computed(() => session.value !== null)

  function applyLifecycleState(state: ProjectLifecycleState): void {
    lifecycle.value = structuredClone(state)
    if (state.status === "closed") {
      projectAssets.value = []
      projectRef.value = null
      projectGraphRef.value = null
    }
  }

  function applyWorkspace(workspace: ProjectWorkspaceSnapshot): void {
    projectRef.value = structuredClone(workspace.project)
    projectGraphRef.value = structuredClone(workspace.projectGraph)
    lifecycle.value = openState(workspace.session)
    projectAssets.value = structuredClone(workspace.assets)
    rpcError.value = ""
  }

  function applyDesktopSession(ref: DesktopSessionRef): void {
    desktopSession.value = structuredClone(ref)
  }

  function applyBootstrap(snapshot: ApplicationBootstrapSnapshot): void {
    applyDesktopSession(snapshot.desktopSession)
    applyLifecycleState(snapshot.lifecycle.project)
    if (snapshot.workspace) applyWorkspace(snapshot.workspace)
  }

  async function create(request: CreateProjectRequest): Promise<ProjectWorkspaceSnapshot | null> {
    if (lifecycle.value.status !== "closed" || !desktopSession.value || pendingIntent.value) {
      return null
    }
    pendingIntent.value = "create"
    rpcError.value = ""
    try {
      const result = await window.yadaw.createProject(
        mutationMeta(desktopSession.value, "project-create"),
        request
      )
      if (!result.ok) {
        if (result.error.category !== "cancelled") rpcError.value = rpcErrorMessage(result.error)
        return null
      }
      applyWorkspace(result.value)
      return result.value
    } finally {
      pendingIntent.value = null
    }
  }

  async function open(path?: string): Promise<ProjectWorkspaceSnapshot | null> {
    if (lifecycle.value.status !== "closed" || !desktopSession.value || pendingIntent.value) {
      return null
    }
    pendingIntent.value = "open"
    rpcError.value = ""
    try {
      const prepared = await window.yadaw.prepareOpenProject(readMeta(desktopSession.value), path)
      if (!prepared.ok) {
        if (prepared.error.category !== "cancelled") {
          rpcError.value = rpcErrorMessage(prepared.error)
        }
        return null
      }
      const preparation = prepared.value
      if (!preparation) {
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
          return null
        }
        recover = choice === "recover"
      }
      const result = await window.yadaw.openProject(
        mutationMeta(desktopSession.value, "project-open"),
        preparation.path,
        recover
      )
      if (!result.ok) {
        rpcError.value = rpcErrorMessage(result.error)
        return null
      }
      applyWorkspace(result.value)
      return result.value
    } finally {
      pendingIntent.value = null
    }
  }

  async function save(): Promise<void> {
    if (lifecycle.value.status !== "open" || pendingIntent.value) return
    const previous = lifecycle.value.session
    pendingIntent.value = "save"
    rpcError.value = ""
    try {
      const saved = await window.yadaw.saveProject()
      lifecycle.value = openState(saved ?? previous)
    } catch (reason) {
      rpcError.value = reason instanceof Error ? reason.message : t("errors.unableToSaveProject")
    } finally {
      pendingIntent.value = null
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
    const target = projectRef.value
    if (!target || pendingIntent.value) return false
    pendingIntent.value = "close"
    rpcError.value = ""
    try {
      const result = await window.yadaw.closeProject(
        mutationMeta(target, "project-close"),
        disposition
      )
      if (!result.ok) {
        if (result.error.category !== "cancelled") rpcError.value = rpcErrorMessage(result.error)
        return false
      }
      applyBootstrap(result.value.snapshot)
      return result.value.closed
    } finally {
      pendingIntent.value = null
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
    desktopSession,
    projectRef,
    projectGraphRef,
    pendingIntent,
    projectAssets,
    busy,
    error,
    isOpen,
    applyLifecycleState,
    applyDesktopSession,
    applyBootstrap,
    applyWorkspace,
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

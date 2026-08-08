import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import type {
  ApplicationBootstrapSnapshot,
  CreateProjectRequest,
  DesktopSessionRef,
  OfflineWorkerRef,
  ProjectAssetSummary,
  ProjectConfiguration,
  ProjectGraphRef,
  ProjectLifecycleState,
  ProjectSession,
  ProjectSessionRef,
  ProjectWorkspaceSnapshot
} from "@heron/contracts"
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
  const offlineWorkerRef = shallowRef<OfflineWorkerRef | null>(null)
  const projectRef = shallowRef<ProjectSessionRef | null>(null)
  const projectGraphRef = shallowRef<ProjectGraphRef | null>(null)
  const projectRevision = shallowRef(0)
  const pendingIntent = shallowRef<"create" | "open" | "save" | "close" | null>(null)
  const pendingProjectMutations = shallowRef(0)
  const rpcError = shallowRef("")
  let pendingClose: Promise<boolean> | null = null
  let projectMutationTail: Promise<void> = Promise.resolve()

  const session = computed(() => ("session" in lifecycle.value ? lifecycle.value.session : null))
  const hasUnsavedChanges = computed(
    () => session.value?.dirty === true || pendingProjectMutations.value > 0
  )
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
      projectRevision.value = 0
    }
  }

  function applyWorkspace(workspace: ProjectWorkspaceSnapshot): void {
    projectRef.value = structuredClone(workspace.project)
    projectGraphRef.value = structuredClone(workspace.projectGraph)
    projectRevision.value = workspace.revision
    lifecycle.value = openState(workspace.session)
    projectAssets.value = structuredClone(workspace.assets)
    rpcError.value = ""
  }

  function applyDesktopSession(ref: DesktopSessionRef): void {
    desktopSession.value = structuredClone(ref)
  }

  function applyBootstrap(snapshot: ApplicationBootstrapSnapshot): void {
    offlineWorkerRef.value = structuredClone(snapshot.offlineTools.worker)
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
      const result = await window.heron.createProject(
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
      const prepared = await window.heron.prepareOpenProject(readMeta(desktopSession.value), path)
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
      const result = await window.heron.openProject(
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
      const target = projectRef.value
      if (!target) return
      const saved = await window.heron.saveProject(mutationMeta(target, "project-save"))
      if (!saved.ok) {
        rpcError.value = rpcErrorMessage(saved.error)
        lifecycle.value = openState(previous)
        return
      }
      applyWorkspace(saved.value)
    } finally {
      pendingIntent.value = null
    }
  }

  async function prepareClose(): Promise<"save" | "discard" | null> {
    if (lifecycle.value.status !== "open") return null
    let disposition: "save" | "discard" | "cancel" = "discard"
    if (hasUnsavedChanges.value) {
      const previous = lifecycle.value.session
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
    }
    if (disposition === "cancel") return null
    await projectMutationTail
    const statusAfterMutations = (lifecycle.value as ProjectLifecycleState).status
    if (statusAfterMutations !== "open") return null
    return disposition
  }

  async function closeOnce(disposition?: "save" | "discard" | "cancel"): Promise<boolean> {
    if (lifecycle.value.status === "closed") return true
    if (lifecycle.value.status !== "open" || disposition === "cancel") return false
    const preparedDisposition = disposition ?? (await prepareClose())
    if (!preparedDisposition) return false
    if (disposition) await projectMutationTail
    const target = projectRef.value
    if (!target || pendingIntent.value) return false
    pendingIntent.value = "close"
    rpcError.value = ""
    try {
      const result = await window.heron.closeProject(
        mutationMeta(target, "project-close"),
        preparedDisposition
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
    if (!projectGraphRef.value) return
    const result = await window.heron.updateProjectConfiguration(
      mutationMeta(projectGraphRef.value, "project-configuration", projectRevision.value),
      configuration
    )
    if (!result.ok) {
      rpcError.value = rpcErrorMessage(result.error)
      return
    }
    lifecycle.value = openState(result.value)
    projectRevision.value = result.resourceRevision ?? projectRevision.value
  }

  async function refreshAssets(): Promise<void> {
    if (!session.value || !projectRef.value) return
    const result = await window.heron.listProjectAssets(readMeta(projectRef.value))
    if (!result.ok) {
      rpcError.value = rpcErrorMessage(result.error)
      return
    }
    projectAssets.value = result.value
  }

  async function importAudio(paths?: string[]): Promise<string[]> {
    const target = projectGraphRef.value
    if (!target) return []
    const result = await window.heron.importProjectAudio(
      mutationMeta(target, "project-audio-import", projectRevision.value),
      paths
    )
    if (!result.ok) {
      rpcError.value = rpcErrorMessage(result.error)
      if (result.error.outcome === "unknown") await refreshAssets()
      return []
    }
    if (!result.value) return []
    applyWorkspace(result.value.workspace)
    const warning = result.warnings.find((candidate) => candidate.code === "audio-import-partial")
    if (warning) rpcError.value = t(warning.userMessageKey)
    return result.value.selectedAssetIds
  }

  function resolveDroppedFilePaths(files: readonly File[]): string[] {
    return files.map((file) => window.heron.resolveDroppedFilePath(file)).filter(Boolean)
  }

  async function startAssetAudition(assetId: string): Promise<boolean> {
    const target = projectRef.value
    if (!target) return false
    const result = await window.heron.startAssetAudition(readMeta(target), assetId)
    return result.ok
  }

  async function stopAssetAudition(): Promise<boolean> {
    const target = projectRef.value
    if (!target) return true
    const result = await window.heron.stopAssetAudition(readMeta(target))
    return result.ok
  }

  function markDirty(): void {
    if (lifecycle.value.status === "open" && !lifecycle.value.session.dirty) {
      lifecycle.value = openState({ ...lifecycle.value.session, dirty: true })
    }
  }

  function beginProjectMutation(): () => void {
    pendingProjectMutations.value += 1
    let resolveMutation!: () => void
    const mutation = new Promise<void>((resolve) => {
      resolveMutation = resolve
    })
    projectMutationTail = projectMutationTail.then(
      () => mutation,
      () => mutation
    )
    let settled = false
    return () => {
      if (settled) return
      settled = true
      pendingProjectMutations.value = Math.max(0, pendingProjectMutations.value - 1)
      resolveMutation()
    }
  }

  async function waitForProjectMutations(): Promise<void> {
    await projectMutationTail
  }

  return {
    lifecycle,
    session,
    desktopSession,
    offlineWorkerRef,
    projectRef,
    projectGraphRef,
    projectRevision,
    pendingIntent,
    pendingProjectMutations,
    projectAssets,
    busy,
    error,
    isOpen,
    hasUnsavedChanges,
    applyLifecycleState,
    applyDesktopSession,
    applyBootstrap,
    applyWorkspace,
    create,
    open,
    save,
    prepareClose,
    close,
    updateConfiguration,
    refreshAssets,
    importAudio,
    resolveDroppedFilePaths,
    startAssetAudition,
    stopAssetAudition,
    markDirty,
    beginProjectMutation,
    waitForProjectMutations
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectStore, import.meta.hot))
}

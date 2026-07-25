import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref, shallowRef } from "vue"
import type { Asset } from "@yadaw/project-db/schema"
import { assets, project as projectTable } from "@yadaw/project-db/schema"
import { createProjectDbProxy } from "@yadaw/project-db/proxy"
import { eq } from "drizzle-orm"
import type {
  CreateProjectRequest,
  ProjectConfiguration,
  ProjectLifecycleState,
  ProjectSession
} from "@yadaw/contracts"

const proxy = createProjectDbProxy({ query: (request) => window.yadaw.projectQuery(request) })

function openState(session: ProjectSession, error: string | null = null): ProjectLifecycleState {
  return { status: "open", session: structuredClone(session), error }
}

export const useProjectStore = defineStore("project", () => {
  const lifecycle = shallowRef<ProjectLifecycleState>({ status: "closed", error: null })
  const projectAssets = ref<Asset[]>([])

  const session = computed(() => "session" in lifecycle.value ? lifecycle.value.session : null)
  const busy = computed(() =>
    lifecycle.value.status === "creating" || lifecycle.value.status === "opening" ||
    lifecycle.value.status === "saving" || lifecycle.value.status === "closing"
  )
  const error = computed(() => lifecycle.value.error ?? "")
  const isOpen = computed(() => session.value !== null)

  function applyLifecycleState(state: ProjectLifecycleState): void {
    lifecycle.value = structuredClone(state)
    if (state.status === "closed") projectAssets.value = []
  }

  async function create(request: CreateProjectRequest): Promise<boolean> {
    if (lifecycle.value.status !== "closed") return false
    lifecycle.value = { status: "creating", error: null }
    try {
      const created = await window.yadaw.createProject(request)
      lifecycle.value = openState(created)
      projectAssets.value = []
      return true
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to create project."
      lifecycle.value = {
        status: "closed",
        error: /cancelled/i.test(message) ? null : message
      }
      return false
    }
  }

  async function open(path?: string): Promise<boolean> {
    if (lifecycle.value.status !== "closed") return false
    lifecycle.value = { status: "opening", error: null }
    try {
      const opened = await window.yadaw.openProject(path)
      if (!opened) {
        lifecycle.value = { status: "closed", error: null }
        return false
      }
      lifecycle.value = openState(opened)
      await refreshAssets()
      return true
    } catch (reason) {
      lifecycle.value = {
        status: "closed",
        error: reason instanceof Error ? reason.message : "Unable to open project."
      }
      return false
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
        reason instanceof Error ? reason.message : "Unable to save project."
      )
    }
  }

  async function close(disposition?: "save" | "discard" | "cancel"): Promise<boolean> {
    if (lifecycle.value.status === "closed") return true
    if (lifecycle.value.status !== "open") return false
    const previous = lifecycle.value.session
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
        reason instanceof Error ? reason.message : "Unable to close project."
      )
      return false
    }
  }

  async function updateConfiguration(configuration: ProjectConfiguration): Promise<void> {
    await proxy.update(projectTable).set({
      name: configuration.name,
      sampleRate: configuration.sampleRate,
      tempo: configuration.tempo,
      timeSignatureNumerator: configuration.timeSignatureNumerator,
      timeSignatureDenominator: configuration.timeSignatureDenominator,
      waveformDisplayMode: configuration.waveformDisplayMode
    }).where(eq(projectTable.id, "project"))
    if (lifecycle.value.status === "open") {
      lifecycle.value = openState({
        ...lifecycle.value.session,
        configuration: { ...configuration },
        dirty: true
      })
    }
  }

  async function refreshAssets(): Promise<void> {
    if (!session.value) return
    projectAssets.value = await proxy.select().from(assets).orderBy(assets.createdAt)
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

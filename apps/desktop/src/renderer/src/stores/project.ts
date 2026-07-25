import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, ref } from "vue"
import type { Asset } from "@yadaw/project-db/schema"
import { assets, project as projectTable } from "@yadaw/project-db/schema"
import { createProjectDbProxy } from "@yadaw/project-db/proxy"
import { eq } from "drizzle-orm"
import type { CreateProjectRequest, ProjectConfiguration, ProjectSession } from "@yadaw/contracts"

const proxy = createProjectDbProxy({ query: (request) => window.yadaw.projectQuery(request) })

export const useProjectStore = defineStore("project", () => {
  const session = ref<ProjectSession | null>(null)
  const projectAssets = ref<Asset[]>([])
  const busy = ref(false)
  const error = ref("")
  const isOpen = computed(() => session.value !== null)

  async function create(request: CreateProjectRequest): Promise<boolean> {
    busy.value = true
    error.value = ""
    try {
      session.value = await window.yadaw.createProject(request)
      projectAssets.value = []
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to create project."
      return false
    } finally {
      busy.value = false
    }
  }

  async function open(path?: string): Promise<boolean> {
    busy.value = true
    error.value = ""
    try {
      session.value = await window.yadaw.openProject(path)
      if (!session.value) return false
      await refreshAssets()
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to open project."
      return false
    } finally {
      busy.value = false
    }
  }

  async function save(): Promise<void> {
    const saved = await window.yadaw.saveProject()
    if (saved) session.value = saved
  }

  async function close(disposition?: "save" | "discard" | "cancel"): Promise<boolean> {
    const closed = await window.yadaw.closeProject(disposition)
    if (closed) {
      session.value = null
      projectAssets.value = []
    }
    return closed
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
    if (session.value) {
      session.value.configuration = { ...configuration }
      session.value.dirty = true
    }
  }

  async function refreshAssets(): Promise<void> {
    projectAssets.value = await proxy.select().from(assets).orderBy(assets.createdAt)
  }

  function markDirty(): void {
    if (session.value) session.value.dirty = true
  }

  return {
    session,
    projectAssets,
    busy,
    error,
    isOpen,
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

import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { ProjectCommand, ProjectCommandResult } from "@yadaw/contracts"
import { inverseFor } from "@yadaw/project-model"
import { useProjectGraphStore } from "./projectGraph"

export interface ProjectHistoryEntry {
  forward: ProjectCommand
  inverse: ProjectCommand
}

export const useProjectHistoryStore = defineStore("project-history", () => {
  const graphStore = useProjectGraphStore()
  const undoHistory = shallowRef<ProjectHistoryEntry[]>([])
  const redoHistory = shallowRef<ProjectHistoryEntry[]>([])
  const canUndo = computed(() => undoHistory.value.length > 0)
  const canRedo = computed(() => redoHistory.value.length > 0)

  function record(entry: ProjectHistoryEntry): void {
    undoHistory.value = [...undoHistory.value, entry]
    redoHistory.value = []
  }

  function acceptExternalResult(result: ProjectCommandResult): void {
    graphStore.acceptExternalResult(result)
    record({ forward: inverseFor(result.graph, result.inverse), inverse: result.inverse })
  }

  async function undo(): Promise<void> {
    const entry = undoHistory.value.at(-1)
    if (!entry || !(await graphStore.execute(entry.inverse))) return
    undoHistory.value = undoHistory.value.slice(0, -1)
    redoHistory.value = [...redoHistory.value, entry]
  }

  async function redo(): Promise<void> {
    const entry = redoHistory.value.at(-1)
    if (!entry || !(await graphStore.execute(entry.forward))) return
    redoHistory.value = redoHistory.value.slice(0, -1)
    undoHistory.value = [...undoHistory.value, entry]
  }

  function clear(): void {
    undoHistory.value = []
    redoHistory.value = []
  }

  return {
    undoHistory,
    redoHistory,
    canUndo,
    canRedo,
    record,
    acceptExternalResult,
    undo,
    redo,
    clear
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectHistoryStore, import.meta.hot))
}

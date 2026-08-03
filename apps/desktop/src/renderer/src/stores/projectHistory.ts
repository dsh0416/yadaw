import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { ProjectCommand, ProjectCommandResult } from "@heron/contracts"
import { inverseFor } from "@heron/project-model"
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
  let sourceEpoch: string | null = null
  let lastSequence = 0
  let unsubscribeExternal: (() => void) | null = null

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

  function startExternalSubscription(): void {
    unsubscribeExternal ??= window.heron.subscribeExternalProjectCommands((event) => {
      const epochChanged = sourceEpoch !== null && sourceEpoch !== event.sourceEpoch
      const sequenceGap =
        sourceEpoch === event.sourceEpoch && lastSequence > 0 && event.sequence !== lastSequence + 1
      sourceEpoch = event.sourceEpoch
      lastSequence = event.sequence
      void graphStore
        .reconcileExternalResult(
          event.payload.result,
          event.resourceRevision,
          epochChanged || sequenceGap
        )
        .then((outcome) => {
          if (outcome === "accepted") {
            record({
              forward: inverseFor(event.payload.result.graph, event.payload.result.inverse),
              inverse: event.payload.result.inverse
            })
          } else if (outcome === "reloaded") {
            clear()
          }
        })
    })
  }

  function stopExternalSubscription(): void {
    unsubscribeExternal?.()
    unsubscribeExternal = null
    sourceEpoch = null
    lastSequence = 0
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
    clear,
    startExternalSubscription,
    stopExternalSubscription
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectHistoryStore, import.meta.hot))
}

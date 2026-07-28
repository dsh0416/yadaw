import { computed, shallowRef } from "vue"
import type { ProjectCommand } from "@yadaw/contracts"

export interface MixerHistoryEntry {
  forward: ProjectCommand
  inverse: ProjectCommand
}

export function useMixerHistory() {
  const undoHistory = shallowRef<MixerHistoryEntry[]>([])
  const redoHistory = shallowRef<MixerHistoryEntry[]>([])
  const canUndo = computed(() => undoHistory.value.length > 0)
  const canRedo = computed(() => redoHistory.value.length > 0)

  function record(entry: MixerHistoryEntry): void {
    undoHistory.value = [...undoHistory.value, entry]
    redoHistory.value = []
  }

  function completeUndo(entry: MixerHistoryEntry): void {
    undoHistory.value = undoHistory.value.slice(0, -1)
    redoHistory.value = [...redoHistory.value, entry]
  }

  function completeRedo(entry: MixerHistoryEntry): void {
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
    completeUndo,
    completeRedo,
    clear
  }
}

import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { MidiImportPlan, MidiImportPreview, MidiImportTrackTarget } from "@yadaw/contracts"
import { secondsToTick } from "../utils/tempoMap"
import { mutationMeta, rpcErrorMessage } from "../rpc"
import { useMixerStore } from "./mixer"
import { useProjectHistoryStore } from "./projectHistory"
import { useProjectStore } from "./project"
import { useTransportStore } from "./transport"

function key(sourceTrack: number, sequence: number): string {
  return `${sequence}:${sourceTrack}`
}

export type MidiTempoMode = "project" | "midi"

export const useMidiImportStore = defineStore("midi-import", () => {
  const mixerStore = useMixerStore()
  const projectHistoryStore = useProjectHistoryStore()
  const projectStore = useProjectStore()
  const transportStore = useTransportStore()
  const preview = shallowRef<MidiImportPreview | null>(null)
  const targets = shallowRef<Record<string, MidiImportTrackTarget>>({})
  const tempoMode = shallowRef<MidiTempoMode>("project")
  const busy = shallowRef(false)
  const error = shallowRef("")
  const open = computed(() => preview.value !== null)

  async function prepare(path?: string): Promise<void> {
    busy.value = true
    error.value = ""
    const target = projectStore.projectRef
    if (!target) {
      busy.value = false
      return
    }
    const result = await window.yadaw.prepareMidiImport(
      mutationMeta(target, "midi-import-prepare"),
      path
    )
    if (result.ok && result.value) {
      preview.value = result.value
      targets.value = Object.fromEntries(
        result.value.tracks.map((track) => [
          key(track.sourceTrack, track.sequence),
          { type: track.noteCount > 0 ? "new" : "ignore" }
        ])
      )
      tempoMode.value = "project"
    } else if (!result.ok) error.value = rpcErrorMessage(result.error)
    busy.value = false
  }

  function targetFor(sourceTrack: number, sequence: number): MidiImportTrackTarget {
    return targets.value[key(sourceTrack, sequence)] ?? { type: "ignore" }
  }

  function setTarget(sourceTrack: number, sequence: number, target: MidiImportTrackTarget): void {
    targets.value = { ...targets.value, [key(sourceTrack, sequence)]: target }
  }

  async function commit(): Promise<boolean> {
    const current = preview.value
    if (!current) return false
    busy.value = true
    error.value = ""
    const plan: MidiImportPlan = {
      token: current.token,
      importTempoMap: tempoMode.value === "midi",
      insertionTick:
        tempoMode.value === "midi"
          ? 0
          : secondsToTick(mixerStore.graph.tempoMap, transportStore.playheadSeconds),
      tracks: current.tracks.map((track) => ({
        sourceTrack: track.sourceTrack,
        sequence: track.sequence,
        target: targetFor(track.sourceTrack, track.sequence)
      }))
    }
    const target = projectStore.projectGraphRef
    if (!target) {
      busy.value = false
      return false
    }
    const result = await window.yadaw.commitMidiImport(
      mutationMeta(target, "midi-import-commit", projectStore.projectRevision),
      plan
    )
    if (!result.ok) {
      error.value = rpcErrorMessage(result.error)
      busy.value = false
      return false
    }
    projectStore.applyWorkspace(result.value.workspace)
    projectHistoryStore.acceptExternalResult(result.value.command)
    preview.value = null
    busy.value = false
    return true
  }

  function close(): void {
    if (busy.value) return
    preview.value = null
    targets.value = {}
    error.value = ""
  }

  return {
    preview,
    targets,
    tempoMode,
    busy,
    error,
    open,
    prepare,
    targetFor,
    setTarget,
    commit,
    close
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMidiImportStore, import.meta.hot))
}

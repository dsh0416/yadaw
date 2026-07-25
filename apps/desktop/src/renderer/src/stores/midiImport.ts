import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type {
  MidiImportPlan,
  MidiImportPreview,
  MidiImportTrackTarget
} from "@yadaw/contracts"
import { secondsToTick } from "../utils/tempoMap"
import { useMixerStore } from "./mixer"
import { useTransportStore } from "./transport"

function key(sourceTrack: number, sequence: number): string {
  return `${sequence}:${sourceTrack}`
}

export type MidiTempoMode = "project" | "midi"

export const useMidiImportStore = defineStore("midi-import", () => {
  const mixerStore = useMixerStore()
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
    try {
      const value = await window.yadaw.prepareMidiImport(path)
      if (!value) return
      preview.value = value
      targets.value = Object.fromEntries(value.tracks.map((track) => [
        key(track.sourceTrack, track.sequence),
        { type: track.noteCount > 0 ? "new" : "ignore" }
      ]))
      tempoMode.value = "project"
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to read the MIDI file."
    } finally {
      busy.value = false
    }
  }

  function targetFor(sourceTrack: number, sequence: number): MidiImportTrackTarget {
    return targets.value[key(sourceTrack, sequence)] ?? { type: "ignore" }
  }

  function setTarget(
    sourceTrack: number,
    sequence: number,
    target: MidiImportTrackTarget
  ): void {
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
      insertionTick: tempoMode.value === "midi"
        ? 0
        : secondsToTick(mixerStore.graph.tempoMap, transportStore.playheadSeconds),
      tracks: current.tracks.map((track) => ({
        sourceTrack: track.sourceTrack,
        sequence: track.sequence,
        target: targetFor(track.sourceTrack, track.sequence)
      }))
    }
    try {
      const result = await window.yadaw.commitMidiImport(plan)
      mixerStore.graph = result.graph
      preview.value = null
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "MIDI import failed."
      return false
    } finally {
      busy.value = false
    }
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

import { acceptHMRUpdate, defineStore } from "pinia"
import { shallowRef } from "vue"
import type {
  MixerParameterPreview,
  ProjectCommand,
  ProjectCommandResult,
  ProjectGraphSnapshot
} from "@yadaw/contracts"
import { MUSICAL_TICKS_PER_QUARTER } from "@yadaw/contracts"
import { applyToGraph, patchMixerGraph } from "@yadaw/project-model"
import { useProjectStore } from "./project"

export const EMPTY_PROJECT_GRAPH: ProjectGraphSnapshot = {
  sampleRate: 48_000,
  tracks: [],
  channels: [],
  audioClips: [],
  sends: [],
  plugins: [],
  midiClips: [],
  tempoMap: {
    ticksPerQuarter: MUSICAL_TICKS_PER_QUARTER,
    tempoEvents: [{ tick: 0, beatsPerMinute: 120 }],
    timeSignatureEvents: [{ tick: 0, numerator: 4, denominator: 4 }]
  },
  keySignatureEvents: [{ tick: 0, fifths: 0, mode: "major" }]
}

export const useProjectGraphStore = defineStore("project-graph", () => {
  const projectStore = useProjectStore()
  const graph = shallowRef<ProjectGraphSnapshot>(structuredClone(EMPTY_PROJECT_GRAPH))
  const loading = shallowRef(false)
  const error = shallowRef("")
  let mutationTail: Promise<void> = Promise.resolve()
  const pendingPreviews = new Map<string, MixerParameterPreview>()
  let previewFlush: Promise<void> | null = null

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(task, task)
    mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function replace(snapshot: ProjectGraphSnapshot): void {
    graph.value = structuredClone(snapshot)
  }

  function hydrate(snapshot: ProjectGraphSnapshot): void {
    replace(snapshot)
    error.value = ""
  }

  async function loadNow(reload: boolean): Promise<void> {
    if (!projectStore.session) return
    loading.value = true
    error.value = ""
    try {
      replace(
        reload ? await window.yadaw.reloadProjectGraph() : await window.yadaw.loadProjectGraph()
      )
    } catch (reason) {
      error.value =
        reason instanceof Error
          ? reason.message
          : reload
            ? "Unable to reload the project graph."
            : "Unable to load the project graph."
    } finally {
      loading.value = false
    }
  }

  function load(): Promise<void> {
    return enqueue(() => loadNow(false))
  }

  function reload(): Promise<void> {
    return enqueue(() => loadNow(true))
  }

  function execute(command: ProjectCommand): Promise<ProjectCommandResult | null> {
    return enqueue(async () => {
      error.value = ""
      await flushPreviews()
      const previous = graph.value
      try {
        graph.value = applyToGraph(previous, command)
        const result = await window.yadaw.executeProjectCommand(command)
        replace(result.graph)
        projectStore.markDirty()
        return result
      } catch (reason) {
        graph.value = previous
        error.value =
          reason instanceof Error ? reason.message : "Project change could not be applied."
        await loadNow(false)
        return null
      }
    })
  }

  function preview(value: MixerParameterPreview): void {
    graph.value = patchMixerGraph(graph.value, value.target, value.id, {
      [value.parameter]: value.value
    })
    pendingPreviews.set(`${value.target}:${value.id}:${value.parameter}`, value)
    previewFlush ??= Promise.resolve().then(flushPreviews)
  }

  async function flushPreviews(): Promise<void> {
    while (pendingPreviews.size > 0) {
      const previews = [...pendingPreviews.values()]
      pendingPreviews.clear()
      try {
        await Promise.all(previews.map((value) => window.yadaw.previewMixerParameter(value)))
      } catch (reason) {
        error.value = reason instanceof Error ? reason.message : "Mixer preview failed."
      }
    }
    previewFlush = null
  }

  function acceptExternalResult(result: ProjectCommandResult): void {
    replace(result.graph)
    projectStore.markDirty()
  }

  function reset(): void {
    graph.value = structuredClone(EMPTY_PROJECT_GRAPH)
    error.value = ""
    loading.value = false
    pendingPreviews.clear()
    previewFlush = null
  }

  return {
    graph,
    loading,
    error,
    hydrate,
    replace,
    load,
    reload,
    execute,
    preview,
    flushPreviews,
    acceptExternalResult,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useProjectGraphStore, import.meta.hot))
}

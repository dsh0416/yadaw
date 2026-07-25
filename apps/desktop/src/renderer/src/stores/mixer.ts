import { useIntervalFn } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type {
  MixerChannelPatch,
  MixerChannelState,
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  MixerSendPatch,
  MixerSendState,
  ProjectCommand
} from "@yadaw/contracts"
import { useProjectStore } from "./project"

interface HistoryEntry {
  forward: ProjectCommand
  inverse: ProjectCommand
}

const EMPTY_GRAPH: MixerGraphSnapshot = {
  sampleRate: 48_000,
  channels: [],
  clips: [],
  sends: []
}

const TRACK_COLORS = ["#8C83FF", "#67D9E7", "#E8B85F", "#EF7C95", "#73D6A2", "#B691F1"]

function patchGraph(
  graph: MixerGraphSnapshot,
  target: "channel" | "send",
  id: string,
  patch: Record<string, unknown>
): MixerGraphSnapshot {
  const next = structuredClone(graph)
  const values = target === "channel" ? next.channels : next.sends
  const value = values.find((candidate) => candidate.id === id)
  if (value) Object.assign(value, patch)
  return next
}

function isAcyclic(graph: MixerGraphSnapshot): boolean {
  const edges = new Map(graph.channels.map((channel) => [channel.id, [] as string[]]))
  for (const channel of graph.channels) {
    if (channel.outputChannelId) edges.get(channel.id)?.push(channel.outputChannelId)
  }
  for (const send of graph.sends) {
    edges.get(send.sourceChannelId)?.push(send.targetChannelId)
  }
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false
    if (visited.has(id)) return true
    visiting.add(id)
    for (const next of edges.get(id) ?? []) {
      if (!visit(next)) return false
    }
    visiting.delete(id)
    visited.add(id)
    return true
  }
  return graph.channels.every((channel) => visit(channel.id))
}

export const useMixerStore = defineStore("mixer", () => {
  const projectStore = useProjectStore()
  const graph = shallowRef<MixerGraphSnapshot>(structuredClone(EMPTY_GRAPH))
  const runtime = shallowRef<MixerRuntimeSnapshot>({ meters: [], capturedAt: 0 })
  const selectedChannelId = shallowRef<string | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  const undoHistory = shallowRef<HistoryEntry[]>([])
  const redoHistory = shallowRef<HistoryEntry[]>([])

  const channels = computed(() => graph.value.channels)
  const audioTracks = computed(() =>
    channels.value.filter((channel) => channel.kind === "audio")
  )
  const buses = computed(() =>
    channels.value.filter((channel) => channel.kind === "bus")
  )
  const master = computed(() =>
    channels.value.find((channel) => channel.kind === "master") ?? null
  )
  const outputs = computed(() =>
    channels.value.filter((channel) => channel.kind === "output")
  )
  const orderedChannels = computed(() => [
    ...audioTracks.value,
    ...buses.value,
    ...(master.value ? [master.value] : []),
    ...outputs.value
  ])
  const selectedChannel = computed(() =>
    channels.value.find((channel) => channel.id === selectedChannelId.value) ?? null
  )
  const canUndo = computed(() => undoHistory.value.length > 0)
  const canRedo = computed(() => redoHistory.value.length > 0)

  async function load(): Promise<void> {
    if (!projectStore.session) return
    loading.value = true
    error.value = ""
    try {
      graph.value = await window.yadaw.loadMixerGraph()
      selectedChannelId.value ??= graph.value.channels.find((channel) => channel.kind === "audio")?.id
        ?? graph.value.channels[0]?.id
        ?? null
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to load the mixer."
    } finally {
      loading.value = false
    }
  }

  async function execute(command: ProjectCommand, recordHistory = true): Promise<boolean> {
    error.value = ""
    try {
      const result = await window.yadaw.executeProjectCommand(command)
      graph.value = result.graph
      projectStore.markDirty()
      if (recordHistory) {
        undoHistory.value = [...undoHistory.value, { forward: command, inverse: result.inverse }]
        redoHistory.value = []
      }
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Mixer change could not be applied."
      await load()
      return false
    }
  }

  async function undo(): Promise<void> {
    const entry = undoHistory.value.at(-1)
    if (!entry) return
    if (await execute(entry.inverse, false)) {
      undoHistory.value = undoHistory.value.slice(0, -1)
      redoHistory.value = [...redoHistory.value, entry]
    }
  }

  async function redo(): Promise<void> {
    const entry = redoHistory.value.at(-1)
    if (!entry) return
    if (await execute(entry.forward, false)) {
      redoHistory.value = redoHistory.value.slice(0, -1)
      undoHistory.value = [...undoHistory.value, entry]
    }
  }

  function preview(previewValue: MixerParameterPreview): void {
    graph.value = patchGraph(
      graph.value,
      previewValue.target,
      previewValue.id,
      { [previewValue.parameter]: previewValue.value }
    )
    void window.yadaw.previewMixerParameter(previewValue).catch((reason: unknown) => {
      error.value = reason instanceof Error ? reason.message : "Mixer preview failed."
    })
  }

  function updateChannel(channelId: string, patch: MixerChannelPatch): Promise<boolean> {
    return execute({ type: "update-channel", channelId, patch })
  }

  function updateSend(sendId: string, patch: MixerSendPatch): Promise<boolean> {
    return execute({ type: "update-send", sendId, patch })
  }

  function createAudioTrack(inputFormat: "mono" | "stereo" = "stereo"): Promise<boolean> {
    const index = audioTracks.value.length
    const defaultOutput = outputs.value[0]
    const channel: MixerChannelState = {
      id: crypto.randomUUID(),
      kind: "audio",
      name: `Audio ${index + 1}`,
      color: TRACK_COLORS[index % TRACK_COLORS.length]!,
      sortOrder: index,
      inputFormat,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: defaultOutput?.id ?? null,
      recordArmed: false,
      inputChannels: inputFormat === "mono" ? [1] : [1, 2],
      hardwareOutputChannels: []
    }
    selectedChannelId.value = channel.id
    return execute({ type: "create-channel", channel })
  }

  function createBus(): Promise<boolean> {
    const index = buses.value.length
    const defaultOutput = outputs.value[0]
    const channel: MixerChannelState = {
      id: crypto.randomUUID(),
      kind: "bus",
      name: `Bus ${index + 1}`,
      color: "#E8B85F",
      sortOrder: index,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: defaultOutput?.id ?? null,
      recordArmed: false,
      inputChannels: [],
      hardwareOutputChannels: []
    }
    selectedChannelId.value = channel.id
    return execute({ type: "create-channel", channel })
  }

  function createOutput(): Promise<boolean> {
    const index = outputs.value.length
    const usedMappings = new Set(
      outputs.value.map((output) => output.hardwareOutputChannels.join(","))
    )
    let firstHardwareChannel = 1
    while (
      firstHardwareChannel < 32 &&
      usedMappings.has(`${firstHardwareChannel},${firstHardwareChannel + 1}`)
    ) {
      firstHardwareChannel += 2
    }
    if (firstHardwareChannel > 31) {
      error.value = "All 16 hardware output pairs are already in use."
      return Promise.resolve(false)
    }
    const channel: MixerChannelState = {
      id: crypto.randomUUID(),
      kind: "output",
      name: `Output ${firstHardwareChannel}–${firstHardwareChannel + 1}`,
      color: "#73D6A2",
      sortOrder: index,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      recordArmed: false,
      inputChannels: [],
      hardwareOutputChannels: [firstHardwareChannel, firstHardwareChannel + 1]
    }
    selectedChannelId.value = channel.id
    return execute({ type: "create-channel", channel })
  }

  async function deleteChannel(channelId: string): Promise<boolean> {
    const channel = channels.value.find((candidate) => candidate.id === channelId)
    if (!channel || channel.kind === "master") return false
    const completed = await execute({ type: "delete-channel", channelId })
    if (completed && selectedChannelId.value === channelId) {
      selectedChannelId.value = graph.value.channels[0]?.id ?? null
    }
    return completed
  }

  function addSend(sourceChannelId: string, targetChannelId: string): Promise<boolean> {
    const send: MixerSendState = {
      id: crypto.randomUUID(),
      sourceChannelId,
      targetChannelId,
      sortOrder: graph.value.sends.filter((candidate) =>
        candidate.sourceChannelId === sourceChannelId).length,
      enabled: false,
      tap: "post",
      levelDb: -90,
      pan: 0
    }
    return execute({ type: "create-send", send })
  }

  function deleteSend(sendId: string): Promise<boolean> {
    return execute({ type: "delete-send", sendId })
  }

  function sendsFor(channelId: string): MixerSendState[] {
    return graph.value.sends.filter((send) => send.sourceChannelId === channelId)
  }

  function meterFor(channelId: string) {
    return runtime.value.meters.find((meter) => meter.channelId === channelId) ?? {
      channelId,
      preFaderPeak: [0, 0] as [number, number],
      postFaderPeak: [0, 0] as [number, number],
      heldPeak: [0, 0] as [number, number],
      clipped: false
    }
  }

  function availableOutputs(channelId: string): MixerChannelState[] {
    const source = channels.value.find((channel) => channel.id === channelId)
    if (!source || (source.kind !== "audio" && source.kind !== "bus")) return []
    return channels.value.filter((target) => {
      if (
        target.id === source.id ||
        (target.kind !== "bus" && target.kind !== "output")
      ) return false
      const candidate = structuredClone(graph.value)
      const candidateSource = candidate.channels.find((channel) => channel.id === source.id)
      if (!candidateSource) return false
      candidateSource.outputChannelId = target.id
      return isAcyclic(candidate)
    })
  }

  function availableSendTargets(channelId: string): MixerChannelState[] {
    const source = channels.value.find((channel) => channel.id === channelId)
    if (!source || (source.kind !== "audio" && source.kind !== "bus")) return []
    const existing = new Set(sendsFor(channelId).map((send) => send.targetChannelId))
    return buses.value.filter((target) => {
      if (target.id === channelId || existing.has(target.id)) return false
      const candidate = structuredClone(graph.value)
      candidate.sends.push({
        id: "candidate",
        sourceChannelId: channelId,
        targetChannelId: target.id,
        sortOrder: 0,
        enabled: false,
        tap: "post",
        levelDb: -90,
        pan: 0
      })
      return isAcyclic(candidate)
    })
  }

  async function refreshMeters(): Promise<void> {
    try {
      runtime.value = await window.yadaw.mixerSnapshot()
    } catch {
      // Engine state warnings are surfaced by the existing audio runtime store.
    }
  }

  async function clearMeterClips(): Promise<void> {
    runtime.value = {
      ...runtime.value,
      meters: runtime.value.meters.map((meter) => ({
        ...meter,
        heldPeak: [0, 0],
        clipped: false
      }))
    }
    try {
      await window.yadaw.transportCommand({ type: "clear-meter-clips" })
    } catch (reason) {
      error.value = reason instanceof Error
        ? reason.message
        : "Unable to reset mixer clipping indicators."
    }
  }

  const meterPolling = useIntervalFn(() => void refreshMeters(), 33, { immediate: false })

  function startMetering(): void {
    void refreshMeters()
    meterPolling.resume()
  }

  function stopMetering(): void {
    meterPolling.pause()
  }

  function reset(): void {
    stopMetering()
    graph.value = structuredClone(EMPTY_GRAPH)
    runtime.value = { meters: [], capturedAt: 0 }
    selectedChannelId.value = null
    undoHistory.value = []
    redoHistory.value = []
    error.value = ""
  }

  return {
    graph,
    runtime,
    selectedChannelId,
    loading,
    error,
    channels,
    audioTracks,
    buses,
    master,
    outputs,
    orderedChannels,
    selectedChannel,
    canUndo,
    canRedo,
    load,
    execute,
    undo,
    redo,
    preview,
    updateChannel,
    updateSend,
    createAudioTrack,
    createBus,
    createOutput,
    deleteChannel,
    addSend,
    deleteSend,
    sendsFor,
    meterFor,
    availableOutputs,
    availableSendTargets,
    clearMeterClips,
    startMetering,
    stopMetering,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMixerStore, import.meta.hot))
}

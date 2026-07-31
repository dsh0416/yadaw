import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type {
  MixerChannelKind,
  MixerChannelPatch,
  MixerChannelState,
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRouteTarget,
  MixerRuntimeSnapshot,
  MixerSendPatch,
  MixerSendState,
  ProjectCommand
} from "@yadaw/contracts"
import { DEFAULT_INSTRUMENT_COLOR, MUSICAL_TICKS_PER_QUARTER } from "@yadaw/contracts"
import {
  MIXER_BUSES,
  audioTracks as selectAudioTracks,
  availableOutputTargets as selectAvailableOutputTargets,
  availableSendTargets as selectAvailableSendTargets,
  instrumentTracks as selectInstrumentTracks,
  meterFor as selectMeterFor,
  patchMixerGraph,
  sendsFor as selectSendsFor,
  systemChannels as selectSystemChannels
} from "@yadaw/project-model"
import { UI_DOMAIN_COLORS } from "@yadaw/ui"
import { useProjectStore } from "./project"
import { useMixerHistory } from "./mixer-history"
import { useMixerMeterPolling } from "./mixer-meter-polling"

const EMPTY_GRAPH: MixerGraphSnapshot = {
  sampleRate: 48_000,
  channels: [],
  clips: [],
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

const DEFAULT_CHANNEL_COLORS: Record<MixerChannelKind, string> = {
  audio: UI_DOMAIN_COLORS.audioChannel,
  instrument: DEFAULT_INSTRUMENT_COLOR,
  aux: UI_DOMAIN_COLORS.busChannel,
  master: UI_DOMAIN_COLORS.masterChannel,
  output: UI_DOMAIN_COLORS.outputChannel
}

export const useMixerStore = defineStore("mixer", () => {
  const projectStore = useProjectStore()
  const graph = shallowRef<MixerGraphSnapshot>(structuredClone(EMPTY_GRAPH))
  const runtime = shallowRef<MixerRuntimeSnapshot>({ meters: [], capturedAt: 0 })
  const selectedChannelId = shallowRef<string | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  const history = useMixerHistory()
  const { undoHistory, redoHistory, canUndo, canRedo } = history
  let mutationTail: Promise<void> = Promise.resolve()
  const pendingPreviews = new Map<string, MixerParameterPreview>()
  let previewFlush: Promise<void> | null = null

  const channels = computed(() => graph.value.channels)
  const audioTracks = computed(() => selectAudioTracks(channels.value))
  const instrumentTracks = computed(() => selectInstrumentTracks(channels.value))
  const systemChannels = computed(() => selectSystemChannels(channels.value))
  const metronome = computed(
    () => channels.value.find((channel) => channel.systemRole === "metronome") ?? null
  )
  const timelineTracks = computed(() =>
    [...audioTracks.value, ...instrumentTracks.value].sort(
      (left, right) => left.sortOrder - right.sortOrder
    )
  )
  const auxChannels = computed(() => channels.value.filter((channel) => channel.kind === "aux"))
  const buses = computed(() => MIXER_BUSES)
  const master = computed(() => channels.value.find((channel) => channel.kind === "master") ?? null)
  const outputs = computed(() => channels.value.filter((channel) => channel.kind === "output"))
  const orderedChannels = computed(() => [
    ...audioTracks.value,
    ...instrumentTracks.value,
    ...systemChannels.value,
    ...auxChannels.value,
    ...(master.value ? [master.value] : []),
    ...outputs.value
  ])
  const selectedChannel = computed(
    () => channels.value.find((channel) => channel.id === selectedChannelId.value) ?? null
  )

  function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(task, task)
    mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  function load(): Promise<void> {
    return enqueueMutation(loadNow)
  }

  function applyGraph(snapshot: MixerGraphSnapshot): void {
    graph.value = structuredClone(snapshot)
    const selectedStillExists = graph.value.channels.some(
      (channel) => channel.id === selectedChannelId.value
    )
    if (!selectedStillExists) {
      selectedChannelId.value =
        graph.value.channels.find((channel) => channel.kind === "audio")?.id ??
        graph.value.channels[0]?.id ??
        null
    }
  }

  function hydrate(snapshot: MixerGraphSnapshot): void {
    applyGraph(snapshot)
    history.clear()
    error.value = ""
  }

  async function loadNow(): Promise<void> {
    if (!projectStore.session) return
    loading.value = true
    error.value = ""
    try {
      applyGraph(await window.yadaw.loadMixerGraph())
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to load the mixer."
    } finally {
      loading.value = false
    }
  }

  function reload(): Promise<void> {
    return enqueueMutation(reloadNow)
  }

  async function reloadNow(): Promise<void> {
    if (!projectStore.session) return
    loading.value = true
    error.value = ""
    try {
      applyGraph(await window.yadaw.reloadMixerGraph())
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to reload the mixer."
    } finally {
      loading.value = false
    }
  }

  function execute(command: ProjectCommand, recordHistory = true): Promise<boolean> {
    return enqueueMutation(() => executeNow(command, recordHistory))
  }

  async function executeNow(command: ProjectCommand, recordHistory = true): Promise<boolean> {
    error.value = ""
    try {
      await flushPreviews()
      const result = await window.yadaw.executeProjectCommand(command)
      graph.value = result.graph
      projectStore.markDirty()
      if (recordHistory) {
        history.record({ forward: command, inverse: result.inverse })
      }
      return true
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Mixer change could not be applied."
      await loadNow()
      return false
    }
  }

  function undo(): Promise<void> {
    return enqueueMutation(undoNow)
  }

  async function undoNow(): Promise<void> {
    const entry = undoHistory.value.at(-1)
    if (!entry) return
    if (await executeNow(entry.inverse, false)) {
      history.completeUndo(entry)
    }
  }

  function redo(): Promise<void> {
    return enqueueMutation(redoNow)
  }

  async function redoNow(): Promise<void> {
    const entry = redoHistory.value.at(-1)
    if (!entry) return
    if (await executeNow(entry.forward, false)) {
      history.completeRedo(entry)
    }
  }

  function preview(previewValue: MixerParameterPreview): void {
    graph.value = patchMixerGraph(graph.value, previewValue.target, previewValue.id, {
      [previewValue.parameter]: previewValue.value
    })
    const key = `${previewValue.target}:${previewValue.id}:${previewValue.parameter}`
    pendingPreviews.set(key, previewValue)
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

  function updateChannel(channelId: string, patch: MixerChannelPatch): Promise<boolean> {
    return execute({ type: "update-channel", channelId, patch })
  }

  function toggleMetronome(): Promise<boolean> {
    const channel = metronome.value
    if (!channel) return Promise.resolve(false)
    return execute(
      {
        type: "update-channel",
        channelId: channel.id,
        patch: { muted: !channel.muted }
      },
      false
    )
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
      systemRole: null,
      name: `Audio ${index + 1}`,
      color: DEFAULT_CHANNEL_COLORS.audio,
      sortOrder: index,
      inputSource: "hardware",
      inputFormat,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: defaultOutput?.id ?? null,
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: inputFormat === "mono" ? [1] : [1, 2],
      hardwareOutputChannels: []
    }
    selectedChannelId.value = channel.id
    return execute({ type: "create-channel", channel })
  }

  function createInstrumentTrack(): Promise<boolean> {
    const index = instrumentTracks.value.length
    const defaultOutput = outputs.value[0]
    const channel: MixerChannelState = {
      id: crypto.randomUUID(),
      kind: "instrument",
      systemRole: null,
      name: `Instrument ${index + 1}`,
      color: DEFAULT_CHANNEL_COLORS.instrument,
      sortOrder: index,
      inputSource: null,
      inputFormat: null,
      midiInput: { portId: null, portName: null, channel: null },
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: defaultOutput?.id ?? null,
      outputBus: null,
      recordArmed: false,
      inputMonitoring: true,
      inputChannels: [],
      hardwareOutputChannels: []
    }
    selectedChannelId.value = channel.id
    return execute({ type: "create-channel", channel })
  }

  function createAux(inputFormat: "mono" | "stereo" = "stereo"): Promise<boolean> {
    const index = auxChannels.value.length
    const defaultOutput = outputs.value[0]
    const channel: MixerChannelState = {
      id: crypto.randomUUID(),
      kind: "aux",
      systemRole: null,
      name: `Aux ${index + 1}`,
      color: DEFAULT_CHANNEL_COLORS.aux,
      sortOrder: index,
      inputSource: "bus",
      inputFormat,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: defaultOutput?.id ?? null,
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: inputFormat === "mono" ? [1] : [1, 2],
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
      systemRole: null,
      name: `Output ${firstHardwareChannel}–${firstHardwareChannel + 1}`,
      color: DEFAULT_CHANNEL_COLORS.output,
      sortOrder: index,
      inputSource: null,
      inputFormat: null,
      gainDb: 0,
      pan: 0,
      muted: false,
      soloed: false,
      outputChannelId: null,
      outputBus: null,
      recordArmed: false,
      inputMonitoring: false,
      inputChannels: [],
      hardwareOutputChannels: [firstHardwareChannel, firstHardwareChannel + 1]
    }
    selectedChannelId.value = channel.id
    return execute({ type: "create-channel", channel })
  }

  async function deleteChannel(channelId: string): Promise<boolean> {
    const channel = channels.value.find((candidate) => candidate.id === channelId)
    if (!channel || channel.kind === "master" || channel.systemRole !== null) return false
    const completed = await execute({ type: "delete-channel", channelId })
    if (completed && selectedChannelId.value === channelId) {
      selectedChannelId.value = graph.value.channels[0]?.id ?? null
    }
    return completed
  }

  function addSend(sourceChannelId: string, target: MixerRouteTarget): Promise<boolean> {
    const send: MixerSendState = {
      id: crypto.randomUUID(),
      sourceChannelId,
      targetChannelId: target.kind === "output" ? target.channelId : null,
      targetBus: target.kind === "bus" ? target.bus : null,
      sortOrder: graph.value.sends.filter(
        (candidate) => candidate.sourceChannelId === sourceChannelId
      ).length,
      enabled: false,
      tap: "post-pan",
      levelDb: -90
    }
    return execute({ type: "create-send", send })
  }

  function deleteSend(sendId: string): Promise<boolean> {
    return execute({ type: "delete-send", sendId })
  }

  function sendsFor(channelId: string): MixerSendState[] {
    return selectSendsFor(graph.value, channelId)
  }

  function meterFor(channelId: string) {
    return selectMeterFor(runtime.value, channelId)
  }

  function availableOutputTargets(channelId: string): MixerRouteTarget[] {
    return selectAvailableOutputTargets(graph.value, channelId)
  }

  function availableSendTargets(channelId: string): MixerRouteTarget[] {
    return selectAvailableSendTargets(graph.value, channelId)
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
      runtime.value = await window.yadaw.clearMixerMeterClips()
    } catch (reason) {
      error.value =
        reason instanceof Error ? reason.message : "Unable to reset mixer clipping indicators."
    }
  }

  const meterPolling = useMixerMeterPolling(refreshMeters)

  function startMetering(): void {
    meterPolling.start()
  }

  function stopMetering(): void {
    meterPolling.stop()
  }

  function reset(): void {
    stopMetering()
    graph.value = structuredClone(EMPTY_GRAPH)
    runtime.value = { meters: [], capturedAt: 0 }
    selectedChannelId.value = null
    history.clear()
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
    instrumentTracks,
    auxChannels,
    systemChannels,
    metronome,
    timelineTracks,
    buses,
    master,
    outputs,
    orderedChannels,
    selectedChannel,
    canUndo,
    canRedo,
    hydrate,
    load,
    reload,
    execute,
    undo,
    redo,
    preview,
    updateChannel,
    toggleMetronome,
    updateSend,
    createAudioTrack,
    createInstrumentTrack,
    createAux,
    createOutput,
    deleteChannel,
    addSend,
    deleteSend,
    sendsFor,
    meterFor,
    availableOutputTargets,
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

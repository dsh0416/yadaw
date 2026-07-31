import { acceptHMRUpdate, defineStore, storeToRefs } from "pinia"
import { computed, shallowRef } from "vue"
import type {
  MixerChannelKind,
  MixerChannelPatch,
  MixerChannelState,
  MixerRouteTarget,
  MixerSendPatch,
  MixerSendState,
  ProjectCommand
} from "@yadaw/contracts"
import { DEFAULT_INSTRUMENT_COLOR } from "@yadaw/contracts"
import {
  MIXER_BUSES,
  audioTracks as selectAudioTracks,
  availableOutputTargets as selectAvailableOutputTargets,
  availableSendTargets as selectAvailableSendTargets,
  instrumentTracks as selectInstrumentTracks,
  sendsFor as selectSendsFor,
  systemChannels as selectSystemChannels
} from "@yadaw/project-model"
import { UI_DOMAIN_COLORS } from "@yadaw/ui"
import { useMixerRuntimeStore } from "./mixerRuntime"
import { useProjectGraphStore } from "./projectGraph"
import { useProjectHistoryStore } from "./projectHistory"

const DEFAULT_CHANNEL_COLORS: Record<MixerChannelKind, string> = {
  audio: UI_DOMAIN_COLORS.audioChannel,
  instrument: DEFAULT_INSTRUMENT_COLOR,
  aux: UI_DOMAIN_COLORS.busChannel,
  master: UI_DOMAIN_COLORS.masterChannel,
  output: UI_DOMAIN_COLORS.outputChannel
}

export const useMixerStore = defineStore("mixer", () => {
  const graphStore = useProjectGraphStore()
  const historyStore = useProjectHistoryStore()
  const runtimeStore = useMixerRuntimeStore()
  const { graph, loading, error: graphError } = storeToRefs(graphStore)
  const { canUndo, canRedo } = storeToRefs(historyStore)
  const { runtime, error: runtimeError } = storeToRefs(runtimeStore)
  const selectedChannelId = shallowRef<string | null>(null)
  const error = computed({
    get: () => graphError.value || runtimeError.value,
    set: (value: string) => {
      graphError.value = value
      if (!value) runtimeError.value = ""
    }
  })

  const channels = computed(() => graph.value.channels)
  const audioTracks = computed(() => selectAudioTracks(channels.value))
  const instrumentTracks = computed(() => selectInstrumentTracks(channels.value))
  const systemChannels = computed(() => selectSystemChannels(channels.value))
  const metronome = computed(
    () => channels.value.find((channel) => channel.systemRole === "metronome") ?? null
  )
  const timelineTracks = computed(() =>
    graph.value.tracks
      .flatMap((track) => {
        const channel = graph.value.channels.find((candidate) => candidate.id === track.channelId)
        return channel ? [{ ...channel, trackId: track.id, sortOrder: track.sortOrder }] : []
      })
      .sort((left, right) => left.sortOrder - right.sortOrder)
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

  function normalizeSelection(): void {
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

  function hydrate(snapshot: Parameters<typeof graphStore.hydrate>[0]): void {
    graphStore.hydrate(snapshot)
    historyStore.clear()
    normalizeSelection()
  }

  async function load(): Promise<void> {
    await graphStore.load()
    normalizeSelection()
  }

  async function reload(): Promise<void> {
    await graphStore.reload()
    normalizeSelection()
  }

  async function execute(command: ProjectCommand, recordHistory = true): Promise<boolean> {
    const result = await graphStore.execute(command)
    if (!result) return false
    if (recordHistory) historyStore.record({ forward: command, inverse: result.inverse })
    return true
  }

  function undo(): Promise<void> {
    return historyStore.undo()
  }

  function redo(): Promise<void> {
    return historyStore.redo()
  }

  const preview = graphStore.preview

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
    return execute({
      type: "create-track",
      track: { id: crypto.randomUUID(), channelId: channel.id, sortOrder: index },
      channel
    })
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
    return execute({
      type: "create-track",
      track: { id: crypto.randomUUID(), channelId: channel.id, sortOrder: index },
      channel
    })
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
    const track = graph.value.tracks.find((candidate) => candidate.channelId === channelId)
    const completed = await execute(
      track ? { type: "delete-track", trackId: track.id } : { type: "delete-channel", channelId }
    )
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
    return runtimeStore.meterFor(channelId)
  }

  function availableOutputTargets(channelId: string): MixerRouteTarget[] {
    return selectAvailableOutputTargets(graph.value, channelId)
  }

  function availableSendTargets(channelId: string): MixerRouteTarget[] {
    return selectAvailableSendTargets(graph.value, channelId)
  }

  function startMetering(): void {
    runtimeStore.startPolling()
  }

  function stopMetering(): void {
    runtimeStore.stopPolling()
  }

  function reset(): void {
    graphStore.reset()
    runtimeStore.reset()
    selectedChannelId.value = null
    historyStore.clear()
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
    clearMeterClips: runtimeStore.clearClips,
    startMetering,
    stopMetering,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMixerStore, import.meta.hot))
}

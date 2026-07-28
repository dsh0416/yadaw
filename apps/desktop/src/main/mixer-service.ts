import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  MidiClipState,
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  MixerSendState,
  MixerChannelState,
  PluginInstanceState,
  ProjectCommand,
  ProjectCommandResult,
  TimelineClipState,
  TransportCommand,
  TransportSnapshot
} from "@yadaw/contracts"
import { type AudioHostGraph, AudioHostService } from "./audio-host-service"
import type { PluginCatalogService } from "./plugin-catalog-service"
import type { ProjectService } from "./project-service"

export interface MidiSourceImport {
  id: string
  name: string
  contentHash: string
  rawBytes: Uint8Array
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`)
  }
}

function cloneGraph(graph: MixerGraphSnapshot): MixerGraphSnapshot {
  return structuredClone(graph)
}

function channelById(graph: MixerGraphSnapshot, id: string): MixerChannelState {
  const channel = graph.channels.find((candidate) => candidate.id === id)
  if (!channel) throw new Error(`Mixer channel '${id}' was not found`)
  return channel
}

function sendById(graph: MixerGraphSnapshot, id: string): MixerSendState {
  const send = graph.sends.find((candidate) => candidate.id === id)
  if (!send) throw new Error(`Mixer send '${id}' was not found`)
  return send
}

function clipById(graph: MixerGraphSnapshot, id: string): TimelineClipState {
  const clip = graph.clips.find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Timeline clip '${id}' was not found`)
  return clip
}

function pluginById(graph: MixerGraphSnapshot, id: string): PluginInstanceState {
  const plugin = graph.plugins.find((candidate) => candidate.id === id)
  if (!plugin) throw new Error(`Plugin instance '${id}' was not found`)
  return plugin
}

function midiClipById(graph: MixerGraphSnapshot, id: string): MidiClipState {
  const clip = graph.midiClips.find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`MIDI clip '${id}' was not found`)
  return clip
}

function movePluginInGraph(
  graph: MixerGraphSnapshot,
  pluginId: string,
  channelId: string,
  role: PluginInstanceState["role"],
  slotOrder: number
): void {
  const plugin = pluginById(graph, pluginId)
  const sourceChannelId = plugin.channelId
  const sourceRole = plugin.role
  const source = graph.plugins
    .filter(
      (candidate) =>
        candidate.id !== pluginId &&
        candidate.channelId === sourceChannelId &&
        candidate.role === sourceRole
    )
    .sort((left, right) => left.slotOrder - right.slotOrder)
  source.forEach((candidate, index) => {
    candidate.slotOrder = sourceRole === "instrument" ? 0 : index
  })

  const destination = graph.plugins
    .filter(
      (candidate) =>
        candidate.id !== pluginId && candidate.channelId === channelId && candidate.role === role
    )
    .sort((left, right) => left.slotOrder - right.slotOrder)
  if (role === "instrument" && destination.length > 0) {
    throw new Error("Replace the assigned instrument instead of moving into an occupied slot")
  }
  const insertionIndex =
    role === "instrument" ? 0 : Math.max(0, Math.min(slotOrder, destination.length))
  destination.splice(insertionIndex, 0, plugin)
  destination.forEach((candidate, index) => {
    candidate.channelId = channelId
    candidate.role = role
    candidate.slotOrder = role === "instrument" ? 0 : index
  })
}

function patchFromKeys<T extends object>(source: T, patch: Partial<T>): Partial<T> {
  return Object.fromEntries(
    Object.keys(patch).map((key) => [key, source[key as keyof T]])
  ) as Partial<T>
}

function inverseFor(graph: MixerGraphSnapshot, command: ProjectCommand): ProjectCommand {
  switch (command.type) {
    case "create-channel":
      return { type: "delete-channel", channelId: command.channel.id }
    case "delete-channel": {
      const channel = channelById(graph, command.channelId)
      if (channel.kind === "master") throw new Error("Master cannot be deleted")
      if (channel.systemRole !== null) throw new Error("System channels cannot be deleted")
      if (
        channel.kind === "output" &&
        (graph.channels.some((candidate) => candidate.outputChannelId === channel.id) ||
          graph.sends.some((send) => send.targetChannelId === channel.id))
      ) {
        throw new Error("An Output must be unused before it can be deleted")
      }
      const affectedOutputs = graph.channels
        .filter((candidate) => candidate.outputChannelId === channel.id)
        .map<ProjectCommand>((candidate) => ({
          type: "update-channel",
          channelId: candidate.id,
          patch: { outputChannelId: channel.id, outputBus: null }
        }))
      const sends = graph.sends
        .filter((send) => send.sourceChannelId === channel.id)
        .map<ProjectCommand>((send) => ({ type: "create-send", send }))
      const clips = graph.clips
        .filter((clip) => clip.trackId === channel.id)
        .map<ProjectCommand>((clip) => ({ type: "create-clip", clip }))
      const plugins = graph.plugins
        .filter((plugin) => plugin.channelId === channel.id)
        .map<ProjectCommand>((plugin) => ({ type: "create-plugin", plugin }))
      const midiClips = graph.midiClips
        .filter((clip) => clip.trackId === channel.id)
        .map<ProjectCommand>((clip) => ({ type: "create-midi-clip", clip }))
      return {
        type: "batch",
        commands: [
          { type: "create-channel", channel },
          ...affectedOutputs,
          ...sends,
          ...clips,
          ...plugins,
          ...midiClips
        ]
      }
    }
    case "update-channel": {
      const channel = channelById(graph, command.channelId)
      return {
        type: "update-channel",
        channelId: command.channelId,
        patch: patchFromKeys(channel, command.patch)
      }
    }
    case "create-send":
      return { type: "delete-send", sendId: command.send.id }
    case "delete-send":
      return { type: "create-send", send: sendById(graph, command.sendId) }
    case "update-send": {
      const send = sendById(graph, command.sendId)
      return {
        type: "update-send",
        sendId: command.sendId,
        patch: patchFromKeys(send, command.patch)
      }
    }
    case "create-clip":
      return { type: "delete-clip", clipId: command.clip.id }
    case "delete-clip":
      return { type: "create-clip", clip: clipById(graph, command.clipId) }
    case "move-clip": {
      const clip = clipById(graph, command.clipId)
      return {
        type: "move-clip",
        clipId: command.clipId,
        trackId: clip.trackId,
        startFrame: clip.startFrame
      }
    }
    case "create-plugin":
      return { type: "delete-plugin", pluginId: command.plugin.id }
    case "delete-plugin":
      return { type: "create-plugin", plugin: pluginById(graph, command.pluginId) }
    case "update-plugin": {
      const plugin = pluginById(graph, command.pluginId)
      return {
        type: "update-plugin",
        pluginId: command.pluginId,
        patch: patchFromKeys(plugin, command.patch)
      }
    }
    case "move-plugin": {
      const plugin = pluginById(graph, command.pluginId)
      return {
        type: "move-plugin",
        pluginId: plugin.id,
        channelId: plugin.channelId,
        role: plugin.role,
        slotOrder: plugin.slotOrder
      }
    }
    case "replace-plugin":
      return {
        type: "replace-plugin",
        pluginId: command.pluginId,
        plugin: pluginById(graph, command.pluginId)
      }
    case "create-midi-clip":
      return { type: "delete-midi-clip", clipId: command.clip.id }
    case "delete-midi-clip":
      return { type: "create-midi-clip", clip: midiClipById(graph, command.clipId) }
    case "move-midi-clip": {
      const clip = midiClipById(graph, command.clipId)
      return {
        type: "move-midi-clip",
        clipId: clip.id,
        trackId: clip.trackId,
        startTick: clip.startTick
      }
    }
    case "replace-tempo-map":
      return { type: "replace-tempo-map", tempoMap: structuredClone(graph.tempoMap) }
    case "replace-key-signature-map":
      return {
        type: "replace-key-signature-map",
        events: structuredClone(graph.keySignatureEvents)
      }
    case "batch": {
      let working = cloneGraph(graph)
      const inverses: ProjectCommand[] = []
      for (const nested of command.commands) {
        inverses.unshift(inverseFor(working, nested))
        working = applyToGraph(working, nested)
      }
      return { type: "batch", commands: inverses }
    }
  }
}

function applyToGraph(graph: MixerGraphSnapshot, command: ProjectCommand): MixerGraphSnapshot {
  const next = cloneGraph(graph)
  switch (command.type) {
    case "create-channel":
      next.channels.push(structuredClone(command.channel))
      break
    case "delete-channel": {
      const master = next.channels.find((channel) => channel.kind === "master")
      if (!master || command.channelId === master.id) throw new Error("Master cannot be deleted")
      const removed = channelById(next, command.channelId)
      if (removed.systemRole !== null) throw new Error("System channels cannot be deleted")
      const fallbackOutput = next.channels.find(
        (channel) => channel.kind === "output" && channel.id !== removed.id
      )
      if (
        removed.kind === "output" &&
        (next.channels.some((channel) => channel.outputChannelId === removed.id) ||
          next.sends.some((send) => send.targetChannelId === removed.id))
      ) {
        throw new Error("An Output must be unused before it can be deleted")
      }
      next.channels = next.channels.filter((channel) => channel.id !== command.channelId)
      for (const channel of next.channels) {
        if (channel.outputChannelId === command.channelId) {
          if (!fallbackOutput) throw new Error("Mixer graph requires a hardware Output")
          channel.outputChannelId = fallbackOutput.id
        }
      }
      next.sends = next.sends.filter((send) => send.sourceChannelId !== command.channelId)
      next.clips = next.clips.filter((clip) => clip.trackId !== command.channelId)
      next.plugins = next.plugins.filter((plugin) => plugin.channelId !== command.channelId)
      next.midiClips = next.midiClips.filter((clip) => clip.trackId !== command.channelId)
      break
    }
    case "update-channel":
      Object.assign(channelById(next, command.channelId), command.patch)
      break
    case "create-send":
      next.sends.push(structuredClone(command.send))
      break
    case "delete-send":
      next.sends = next.sends.filter((send) => send.id !== command.sendId)
      break
    case "update-send":
      Object.assign(sendById(next, command.sendId), command.patch)
      break
    case "create-clip":
      next.clips.push(structuredClone(command.clip))
      break
    case "delete-clip":
      next.clips = next.clips.filter((clip) => clip.id !== command.clipId)
      break
    case "move-clip": {
      const clip = clipById(next, command.clipId)
      clip.trackId = command.trackId
      clip.startFrame = command.startFrame
      break
    }
    case "create-plugin":
      next.plugins.push(structuredClone(command.plugin))
      break
    case "delete-plugin":
      next.plugins = next.plugins.filter((plugin) => plugin.id !== command.pluginId)
      break
    case "update-plugin":
      Object.assign(pluginById(next, command.pluginId), command.patch)
      break
    case "move-plugin": {
      movePluginInGraph(next, command.pluginId, command.channelId, command.role, command.slotOrder)
      break
    }
    case "replace-plugin": {
      const index = next.plugins.findIndex((plugin) => plugin.id === command.pluginId)
      if (index < 0) throw new Error(`Plugin instance '${command.pluginId}' was not found`)
      next.plugins[index] = structuredClone(command.plugin)
      break
    }
    case "create-midi-clip":
      next.midiClips.push(structuredClone(command.clip))
      break
    case "delete-midi-clip":
      next.midiClips = next.midiClips.filter((clip) => clip.id !== command.clipId)
      break
    case "move-midi-clip": {
      const clip = midiClipById(next, command.clipId)
      clip.trackId = command.trackId
      clip.startTick = command.startTick
      break
    }
    case "replace-tempo-map":
      next.tempoMap = structuredClone(command.tempoMap)
      break
    case "replace-key-signature-map":
      next.keySignatureEvents = structuredClone(command.events)
      break
    case "batch":
      return command.commands.reduce(applyToGraph, next)
  }
  return next
}

function validateGraph(graph: MixerGraphSnapshot): void {
  const ids = new Set<string>()
  for (const channel of graph.channels) {
    if (!channel.id || ids.has(channel.id)) throw new Error("Mixer channel IDs must be unique")
    if (new TextEncoder().encode(channel.id).length > 64) {
      throw new Error("Mixer channel IDs must be at most 64 UTF-8 bytes")
    }
    ids.add(channel.id)
    finiteRange(channel.gainDb, -90, 12, "Channel gain")
    finiteRange(channel.pan, -1, 1, "Channel pan")
    const supportsAudioInput = channel.kind === "audio" || channel.kind === "aux"
    if (
      supportsAudioInput &&
      channel.inputChannels.length !== (channel.inputFormat === "mono" ? 1 : 2)
    ) {
      throw new Error("Audio and Aux input mappings must match their input format")
    }
    if (supportsAudioInput) {
      const maximumInput = channel.inputSource === "bus" ? 256 : 32
      if (
        channel.inputSource === null ||
        channel.inputFormat === null ||
        channel.inputChannels.some(
          (input) => !Number.isInteger(input) || input < 1 || input > maximumInput
        ) ||
        new Set(channel.inputChannels).size !== channel.inputChannels.length
      ) {
        throw new Error("Audio and Aux channels require a valid hardware or BUS input")
      }
    } else if (
      channel.inputSource !== null ||
      channel.inputFormat !== null ||
      channel.inputChannels.length > 0
    ) {
      throw new Error("Only Audio and Aux channels can map audio inputs")
    }
    if (channel.kind !== "audio" && channel.recordArmed) {
      throw new Error("Only Audio tracks can arm recording")
    }
    if (channel.kind === "master" && channel.soloed) {
      throw new Error("Master cannot be soloed")
    }
    if (channel.systemRole !== null && channel.kind !== "instrument") {
      throw new Error("System channels must be Instrument channels")
    }
    if (channel.kind === "output") {
      if (
        channel.hardwareOutputChannels.length !== 2 ||
        channel.hardwareOutputChannels[0] === channel.hardwareOutputChannels[1] ||
        channel.hardwareOutputChannels.some(
          (output) => !Number.isInteger(output) || output < 1 || output > 32
        )
      ) {
        throw new Error("Output channels must map two distinct hardware channels 1 through 32")
      }
    } else if (channel.hardwareOutputChannels.length > 0) {
      throw new Error("Only Output channels can map hardware outputs")
    }
    if (!Number.isSafeInteger(channel.sortOrder) || channel.sortOrder < 0) {
      throw new Error("Mixer channel order must be a non-negative safe integer")
    }
  }
  const masters = graph.channels.filter((channel) => channel.kind === "master")
  if (masters.length !== 1) throw new Error("Mixer graph requires exactly one Master")
  const systemRoles = graph.channels
    .map((channel) => channel.systemRole)
    .filter((role): role is NonNullable<typeof role> => role !== null)
  if (new Set(systemRoles).size !== systemRoles.length) {
    throw new Error("Mixer system channel roles must be unique")
  }
  const outputs = graph.channels.filter((channel) => channel.kind === "output")
  if (outputs.length === 0) throw new Error("Mixer graph requires at least one hardware Output")
  const outputMappings = new Set(outputs.map((channel) => channel.hardwareOutputChannels.join(",")))
  if (outputMappings.size !== outputs.length) {
    throw new Error("Hardware Output channel pairs must be unique")
  }
  const edges = new Map(graph.channels.map((channel) => [channel.id, [] as string[]]))
  for (const channel of graph.channels) {
    if (channel.kind === "master" || channel.kind === "output") {
      if (channel.outputChannelId !== null || channel.outputBus != null) {
        throw new Error("Master and hardware Outputs cannot route onward")
      }
    } else {
      const targetCount =
        Number(channel.outputChannelId !== null) + Number(channel.outputBus != null)
      if (targetCount !== 1) {
        throw new Error("Audio, Instrument, and Aux channels must target one BUS or Output")
      }
      if (channel.outputChannelId !== null) {
        const output = channelById(graph, channel.outputChannelId)
        if (output.kind !== "output") {
          throw new Error("Mixer output channel targets must reference a hardware Output")
        }
        edges.get(channel.id)!.push(output.id)
      } else if (
        !Number.isSafeInteger(channel.outputBus) ||
        channel.outputBus! < 1 ||
        channel.outputBus! > 256
      ) {
        throw new Error("Mixer BUS output targets must be between 1 and 256")
      } else {
        for (const consumer of graph.channels) {
          if (
            consumer.inputSource === "bus" &&
            consumer.inputChannels.includes(channel.outputBus!)
          ) {
            edges.get(channel.id)!.push(consumer.id)
          }
        }
      }
    }
  }
  const sendIds = new Set<string>()
  const sendRoutes = new Set<string>()
  for (const send of graph.sends) {
    if (!send.id || sendIds.has(send.id)) throw new Error("Mixer send IDs must be unique")
    if (new TextEncoder().encode(send.id).length > 64) {
      throw new Error("Mixer send IDs must be at most 64 UTF-8 bytes")
    }
    sendIds.add(send.id)
    const source = channelById(graph, send.sourceChannelId)
    if (source.kind === "master" || source.kind === "output") {
      throw new Error("Only Audio, Instrument, and Aux channels can source sends")
    }
    const targetCount = Number(send.targetChannelId != null) + Number(send.targetBus !== null)
    if (targetCount !== 1) {
      throw new Error("A send must target exactly one BUS or Output")
    }
    let route: string
    if (send.targetChannelId != null) {
      const output = channelById(graph, send.targetChannelId)
      if (output.kind !== "output") {
        throw new Error("Send Output targets must reference a hardware Output")
      }
      route = `${source.id}:output:${output.id}`
      edges.get(source.id)!.push(output.id)
    } else if (
      !Number.isSafeInteger(send.targetBus) ||
      send.targetBus! < 1 ||
      send.targetBus! > 256
    ) {
      throw new Error("Send BUS targets must be between 1 and 256")
    } else {
      route = `${source.id}:bus:${send.targetBus}`
      for (const consumer of graph.channels) {
        if (consumer.inputSource === "bus" && consumer.inputChannels.includes(send.targetBus!)) {
          edges.get(source.id)!.push(consumer.id)
        }
      }
    }
    if (sendRoutes.has(route)) throw new Error("A channel can only send to each destination once")
    sendRoutes.add(route)
    finiteRange(send.levelDb, -90, 12, "Send level")
    if (!Number.isSafeInteger(send.sortOrder) || send.sortOrder < 0) {
      throw new Error("Mixer send order must be a non-negative safe integer")
    }
  }
  for (const clip of graph.clips) {
    if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0) {
      throw new Error("Clip start frame must be a non-negative safe integer")
    }
    if (
      !Number.isSafeInteger(clip.sourceOffsetFrames) ||
      clip.sourceOffsetFrames < 0 ||
      !Number.isSafeInteger(clip.lengthFrames) ||
      clip.lengthFrames < 1
    ) {
      throw new Error("Clip source offset and length must use valid sample frames")
    }
    const channel = channelById(graph, clip.trackId)
    if (channel.kind !== "audio" || channel.systemRole !== null) {
      throw new Error("Timeline clips must belong to audio tracks")
    }
  }
  const pluginIds = new Set<string>()
  const pluginSlots = new Set<string>()
  for (const plugin of graph.plugins) {
    if (!plugin.id || pluginIds.has(plugin.id))
      throw new Error("Plugin instance IDs must be unique")
    pluginIds.add(plugin.id)
    const channel = channelById(graph, plugin.channelId)
    if (!Number.isSafeInteger(plugin.slotOrder) || plugin.slotOrder < 0) {
      throw new Error("Plugin slot order must be a non-negative safe integer")
    }
    const slot = `${plugin.channelId}:${plugin.role}:${plugin.slotOrder}`
    if (pluginSlots.has(slot)) throw new Error("Plugin slots must be unique within a channel")
    pluginSlots.add(slot)
    if (plugin.role === "instrument") {
      if (
        channel.kind !== "instrument" ||
        plugin.slotOrder !== 0 ||
        plugin.descriptor.kind !== "instrument" ||
        !["mono", "stereo"].includes(plugin.audioMode)
      ) {
        throw new Error("An instrument slot requires an instrument plugin on an Instrument track")
      }
    } else if (
      plugin.descriptor.kind !== "effect" ||
      !["mono", "mono-to-stereo", "stereo", "dual-mono"].includes(plugin.audioMode)
    ) {
      throw new Error("Insert slots only accept effect plug-ins with a valid audio mode")
    }
    if (plugin.classId !== plugin.descriptor.classId) {
      throw new Error("Plugin class ID must match its descriptor snapshot")
    }
    if (!plugin.descriptor.supportedAudioModes.includes(plugin.audioMode)) {
      throw new Error("Plugin audio mode must be supported by its descriptor snapshot")
    }
  }
  if (graph.tempoMap.ticksPerQuarter !== 960) {
    throw new Error("Project tempo maps must use 960 PPQ")
  }
  if (
    graph.tempoMap.tempoEvents[0]?.tick !== 0 ||
    graph.tempoMap.timeSignatureEvents[0]?.tick !== 0
  ) {
    throw new Error("Tempo and time-signature maps require an event at tick 0")
  }
  let previousTempoTick = -1
  for (const event of graph.tempoMap.tempoEvents) {
    if (
      !Number.isSafeInteger(event.tick) ||
      event.tick <= previousTempoTick ||
      !Number.isFinite(event.beatsPerMinute) ||
      event.beatsPerMinute <= 0
    ) {
      throw new Error("Tempo events must be ordered unique ticks with positive BPM")
    }
    previousTempoTick = event.tick
  }
  let previousSignatureTick = -1
  for (const event of graph.tempoMap.timeSignatureEvents) {
    if (
      !Number.isSafeInteger(event.tick) ||
      event.tick <= previousSignatureTick ||
      !Number.isInteger(event.numerator) ||
      event.numerator < 1 ||
      event.numerator > 32 ||
      ![1, 2, 4, 8, 16, 32].includes(event.denominator)
    ) {
      throw new Error("Time-signature events contain invalid values")
    }
    previousSignatureTick = event.tick
  }
  if (graph.keySignatureEvents[0]?.tick !== 0) {
    throw new Error("Key-signature maps require an event at tick 0")
  }
  let previousKeyTick = -1
  for (const event of graph.keySignatureEvents) {
    if (
      !Number.isSafeInteger(event.tick) ||
      event.tick <= previousKeyTick ||
      !Number.isInteger(event.fifths) ||
      event.fifths < -7 ||
      event.fifths > 7 ||
      (event.mode !== "major" && event.mode !== "minor")
    ) {
      throw new Error("Key-signature events contain invalid values")
    }
    previousKeyTick = event.tick
  }
  const midiClipIds = new Set<string>()
  for (const clip of graph.midiClips) {
    if (!clip.id || midiClipIds.has(clip.id)) throw new Error("MIDI clip IDs must be unique")
    midiClipIds.add(clip.id)
    const channel = channelById(graph, clip.trackId)
    if (channel.kind !== "instrument" || channel.systemRole !== null) {
      throw new Error("MIDI clips must belong to Instrument tracks")
    }
    if (
      !Number.isSafeInteger(clip.startTick) ||
      clip.startTick < 0 ||
      !Number.isSafeInteger(clip.sourceOffsetTicks) ||
      clip.sourceOffsetTicks < 0 ||
      !Number.isSafeInteger(clip.lengthTicks) ||
      clip.lengthTicks < 1
    ) {
      throw new Error("MIDI clip positions must use valid musical ticks")
    }
    for (const note of clip.notes) {
      if (
        !Number.isSafeInteger(note.startTick) ||
        note.startTick < 0 ||
        !Number.isSafeInteger(note.durationTicks) ||
        note.durationTicks < 1 ||
        !Number.isInteger(note.channel) ||
        note.channel < 0 ||
        note.channel > 15 ||
        !Number.isInteger(note.key) ||
        note.key < 0 ||
        note.key > 127 ||
        !Number.isInteger(note.velocity) ||
        note.velocity < 1 ||
        note.velocity > 127 ||
        !Number.isInteger(note.releaseVelocity) ||
        note.releaseVelocity < 0 ||
        note.releaseVelocity > 127
      ) {
        throw new Error("MIDI note contains invalid tick, channel, key, or velocity data")
      }
    }
  }

  const visiting = new Set<string>()
  const visited = new Set<string>()
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("Mixer routing would create a feedback loop")
    if (visited.has(id)) return
    visiting.add(id)
    for (const target of edges.get(id) ?? []) visit(target)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of ids) visit(id)
}

function onlyRealtimeParameters(command: ProjectCommand): boolean {
  if (command.type === "batch") return command.commands.every(onlyRealtimeParameters)
  if (command.type === "replace-key-signature-map") return true
  if (command.type === "update-channel") {
    return Object.keys(command.patch).every((key) => key === "gainDb" || key === "pan")
  }
  if (command.type === "update-send") {
    return Object.keys(command.patch).every((key) => key === "levelDb" || key === "pan")
  }
  return false
}

function deletedChannelIds(command: ProjectCommand): Set<string> {
  if (command.type === "delete-channel") return new Set([command.channelId])
  if (command.type !== "batch") return new Set()
  return new Set(command.commands.flatMap((nested) => [...deletedChannelIds(nested)]))
}

export class MixerService {
  private readonly cacheDirectory: string
  private mutationTail: Promise<void> = Promise.resolve()
  private graphRevision = 0
  private testTransport: TransportSnapshot = {
    state: "stopped",
    positionFrames: 0,
    sampleRate: 48_000
  }

  constructor(
    userData: string,
    private readonly projects: ProjectService,
    private readonly audioHost: AudioHostService | null = null,
    private readonly plugins: PluginCatalogService | null = null
  ) {
    this.cacheDirectory = join(userData, "mixer-cache")
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(task, task)
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  async snapshot(): Promise<MixerGraphSnapshot> {
    if (!this.projects.current) throw new Error("No project is open")
    const graph = await this.projects.mixerSnapshot()
    return {
      ...graph,
      plugins: graph.plugins.map((plugin) => ({
        ...plugin,
        descriptor: this.plugins?.resolveDescriptor(plugin.descriptor) ?? plugin.descriptor
      }))
    }
  }
  private async cacheAssets(graph: MixerGraphSnapshot): Promise<Map<string, string>> {
    await mkdir(this.cacheDirectory, { recursive: true })
    const ids = [...new Set(graph.clips.map((clip) => clip.assetId))]
    const contentHashes = new Map(
      (await this.projects.assetContentHashes(ids)).map((asset) => [asset.id, asset.contentHash])
    )
    const result = new Map<string, string>()
    for (const id of ids) {
      const contentHash = contentHashes.get(id) ?? "unknown"
      const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_")
      const path = join(this.cacheDirectory, `${safeId}-${contentHash}.bwf`)
      try {
        await access(path)
      } catch {
        const temporary = `${path}.${process.pid}.tmp`
        try {
          await writeFile(temporary, await this.projects.readAssetAudio(id))
          await rename(temporary, path)
        } finally {
          await rm(temporary, { force: true })
        }
      }
      result.set(id, path)
    }
    return result
  }
  load(): Promise<MixerGraphSnapshot> {
    return this.enqueueMutation(() => this.loadNow())
  }

  private async loadNow(): Promise<MixerGraphSnapshot> {
    const graph = await this.snapshot()
    if (process.env.YADAW_TEST_CAPTURE_SOURCE === "1") {
      this.testTransport.sampleRate = graph.sampleRate
    }
    validateGraph(graph)
    const paths = await this.cacheAssets(graph)
    const runtimeGraph: AudioHostGraph = {
      sample_rate: graph.sampleRate,
      channels: graph.channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        system_role: channel.systemRole ?? undefined,
        gain_db: channel.gainDb,
        pan: channel.pan,
        muted: channel.muted,
        soloed: channel.soloed,
        record_armed: channel.recordArmed,
        input_source: channel.inputSource ?? undefined,
        input_channels: channel.inputChannels,
        hardware_output_channels: channel.hardwareOutputChannels,
        output_channel_id: channel.outputChannelId ?? undefined,
        output_bus: channel.outputBus ?? undefined
      })),
      sends: graph.sends.map((send) => ({
        id: send.id,
        source_channel_id: send.sourceChannelId,
        target_channel_id: send.targetChannelId ?? undefined,
        target_bus: send.targetBus ?? undefined,
        enabled: send.enabled,
        tap: send.tap,
        level_db: send.levelDb
      })),
      clips: graph.clips.map((clip) => ({
        id: clip.id,
        channel_id: clip.trackId,
        start_frame: clip.startFrame,
        source_offset_frames: clip.sourceOffsetFrames,
        length_frames: clip.lengthFrames,
        path: paths.get(clip.assetId)!
      })),
      plugins: graph.plugins.map((plugin) => ({
        instance_id: plugin.id,
        channel_id: plugin.channelId,
        role: plugin.role,
        slot_order: plugin.slotOrder,
        audio_mode: plugin.audioMode,
        enabled: plugin.enabled,
        latency_samples: 0,
        tail_samples: 0
      })),
      midi_clips: graph.midiClips.map((clip) => ({
        id: clip.id,
        channel_id: clip.trackId,
        start_tick: clip.startTick,
        source_offset_ticks: clip.sourceOffsetTicks,
        length_ticks: clip.lengthTicks,
        notes: {
          storage: "inline",
          notes: clip.notes.map((note) => ({
            start_tick: note.startTick,
            duration_ticks: note.durationTicks,
            channel: note.channel,
            key: note.key,
            velocity: note.velocity,
            release_velocity: note.releaseVelocity
          }))
        },
        events: {
          storage: "inline",
          events: clip.events.map((event) => ({
            tick: event.tick,
            channel: event.channel,
            kind: event.kind,
            data: {
              storage: "inline",
              bytes: event.data
            }
          }))
        }
      })),
      tempo_events: graph.tempoMap.tempoEvents.map((event) => ({
        tick: event.tick,
        beats_per_minute: event.beatsPerMinute
      })),
      time_signature_events: graph.tempoMap.timeSignatureEvents.map((event) => ({
        tick: event.tick,
        numerator: event.numerator,
        denominator: event.denominator
      }))
    }
    this.graphRevision += 1
    await this.audioHost?.loadGraph(this.graphRevision, graph, runtimeGraph)
    return graph
  }

  execute(command: ProjectCommand): Promise<ProjectCommandResult> {
    return this.enqueueMutation(() => this.executeNow(command))
  }

  executeMidiImport(
    source: MidiSourceImport,
    command: ProjectCommand
  ): Promise<ProjectCommandResult> {
    return this.enqueueMutation(async () => {
      const before = await this.snapshot()
      const inverse = inverseFor(before, command)
      const candidate = applyToGraph(before, command)
      validateGraph(candidate)
      const fallbackOutput = before.channels.find((channel) => channel.kind === "output")
      if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
      await this.projects.importMidi(source, command, fallbackOutput.id)
      try {
        await this.loadNow()
      } catch (error) {
        await this.projects.rollbackMidi(source.id, inverse, fallbackOutput.id)
        throw error
      }
      return { graph: await this.snapshot(), inverse }
    })
  }

  private async executeNow(command: ProjectCommand): Promise<ProjectCommandResult> {
    const before = await this.snapshot()
    const inverse = inverseFor(before, command)
    const candidate = applyToGraph(before, command)
    validateGraph(candidate)
    const deletedIds = deletedChannelIds(command)
    const fallbackOutput = before.channels.find(
      (channel) => channel.kind === "output" && !deletedIds.has(channel.id)
    )
    if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
    await this.projects.applyProjectCommand(command, fallbackOutput.id)
    try {
      if (onlyRealtimeParameters(command)) {
        await this.previewCommitted(command)
      } else {
        await this.loadNow()
      }
    } catch (error) {
      await this.projects.applyProjectCommand(inverse, fallbackOutput.id)
      throw error
    }
    return { graph: await this.snapshot(), inverse }
  }
  private async previewCommitted(command: ProjectCommand): Promise<void> {
    if (command.type === "batch") {
      for (const nested of command.commands) await this.previewCommitted(nested)
      return
    }
    if (command.type === "update-channel") {
      if (command.patch.gainDb !== undefined) {
        await this.audioHost?.previewMixerParameter({
          target: "channel",
          id: command.channelId,
          parameter: "gainDb",
          value: command.patch.gainDb
        })
      }
      if (command.patch.pan !== undefined) {
        await this.audioHost?.previewMixerParameter({
          target: "channel",
          id: command.channelId,
          parameter: "pan",
          value: command.patch.pan
        })
      }
    } else if (command.type === "update-send") {
      if (command.patch.levelDb !== undefined) {
        await this.audioHost?.previewMixerParameter({
          target: "send",
          id: command.sendId,
          parameter: "levelDb",
          value: command.patch.levelDb
        })
      }
    }
  }

  async preview(preview: MixerParameterPreview): Promise<void> {
    finiteRange(
      preview.value,
      preview.parameter === "pan" ? -1 : -90,
      preview.parameter === "pan" ? 1 : 12,
      "Mixer preview"
    )
    await this.audioHost?.previewMixerParameter(preview)
  }

  async runtimeSnapshot(): Promise<MixerRuntimeSnapshot> {
    return this.audioHost?.mixerSnapshot() ?? { meters: [], capturedAt: Date.now() }
  }

  async clearMeterClips(): Promise<MixerRuntimeSnapshot> {
    return this.audioHost?.clearMeterClips() ?? { meters: [], capturedAt: Date.now() }
  }

  async transport(command: TransportCommand): Promise<TransportSnapshot> {
    if (
      process.env.YADAW_TEST_CAPTURE_SOURCE === "1" &&
      process.env.YADAW_TEST_VIRTUAL_AUDIO !== "1"
    ) {
      if (command.type === "seek") {
        this.testTransport.positionFrames = command.positionFrames
      } else if (command.type === "stop") {
        this.testTransport.state = "stopped"
        this.testTransport.positionFrames = 0
      } else if (command.type === "pause") {
        this.testTransport.state = "stopped"
      } else if (command.type === "play") {
        this.testTransport.state = "playing"
      } else if (command.type === "record") {
        this.testTransport.state = "recording"
      }
      return { ...this.testTransport }
    }
    if (!this.audioHost) throw new Error("Audio host is not running")
    try {
      return await this.audioHost.transport(command)
    } catch (error) {
      if (
        (command.type === "stop" || command.type === "pause") &&
        error instanceof Error &&
        error.message.includes("audio engine must be running before transport")
      ) {
        return {
          state: "stopped",
          positionFrames: 0,
          sampleRate:
            this.projects.current?.configuration.sampleRate ?? this.testTransport.sampleRate
        }
      }
      throw error
    }
  }

  async transportSnapshot(): Promise<TransportSnapshot> {
    if (
      process.env.YADAW_TEST_CAPTURE_SOURCE === "1" &&
      process.env.YADAW_TEST_VIRTUAL_AUDIO !== "1"
    ) {
      return { ...this.testTransport }
    }
    if (!this.audioHost) {
      return { state: "stopped", positionFrames: 0, sampleRate: 0 }
    }
    return this.audioHost.transportSnapshot()
  }
}

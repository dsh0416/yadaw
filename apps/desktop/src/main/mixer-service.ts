import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  MidiClipState,
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  MixerSendPatch,
  MixerSendState,
  MixerChannelPatch,
  MixerChannelState,
  PluginInstancePatch,
  PluginInstanceState,
  ProjectCommand,
  ProjectCommandResult,
  TimelineClipState,
  TransportCommand,
  TransportSnapshot
} from "@yadaw/contracts"
import {
  loadMixerGraph,
  mixerSnapshot,
  previewMixerParameter,
  transportCommand,
  transportSnapshot
} from "@yadaw/dsp-node"
import type { ProjectQueryRequest } from "@yadaw/contracts"
import type { ProjectService } from "./project-service"

interface AssetCacheRow {
  id: string
  contentHash: string
}

export interface MidiSourceImport {
  id: string
  name: string
  contentHash: string
  rawBytes: Uint8Array
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array()
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
      if (
        channel.kind === "output" &&
        graph.channels.some((candidate) => candidate.outputChannelId === channel.id)
      ) {
        throw new Error("An Output must be unused before it can be deleted")
      }
      const affectedOutputs = graph.channels
        .filter((candidate) => candidate.outputChannelId === channel.id)
        .map<ProjectCommand>((candidate) => ({
          type: "update-channel",
          channelId: candidate.id,
          patch: { outputChannelId: channel.id }
        }))
      const sends = graph.sends
        .filter((send) => send.sourceChannelId === channel.id || send.targetChannelId === channel.id)
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
      const fallbackOutput = next.channels.find((channel) =>
        channel.kind === "output" && channel.id !== removed.id
      )
      if (
        removed.kind === "output" &&
        next.channels.some((channel) => channel.outputChannelId === removed.id)
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
      next.sends = next.sends.filter((send) =>
        send.sourceChannelId !== command.channelId && send.targetChannelId !== command.channelId
      )
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
      const plugin = pluginById(next, command.pluginId)
      plugin.channelId = command.channelId
      plugin.role = command.role
      plugin.slotOrder = command.slotOrder
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
    if (
      channel.kind === "audio" &&
      channel.inputChannels.length !== (channel.inputFormat === "mono" ? 1 : 2)
    ) {
      throw new Error("Audio track input mapping does not match its input format")
    }
    if (channel.kind === "audio" && channel.inputChannels.some((input) =>
      !Number.isInteger(input) || input < 1 || input > 32
    )) {
      throw new Error("Audio track inputs must be hardware channels 1 through 32")
    }
    if (channel.kind !== "audio" && (
      channel.inputFormat !== null || channel.inputChannels.length > 0 || channel.recordArmed
    )) {
      throw new Error("Only audio tracks can map or arm hardware inputs")
    }
    if (channel.kind === "master" && channel.soloed) {
      throw new Error("Master cannot be soloed")
    }
    if (channel.kind === "audio" && channel.inputFormat === null) {
      throw new Error("Audio tracks require an input format")
    }
    if (channel.kind === "output") {
      if (
        channel.hardwareOutputChannels.length !== 2 ||
        channel.hardwareOutputChannels[0] === channel.hardwareOutputChannels[1] ||
        channel.hardwareOutputChannels.some((output) =>
          !Number.isInteger(output) || output < 1 || output > 32
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
  const outputs = graph.channels.filter((channel) => channel.kind === "output")
  if (outputs.length === 0) throw new Error("Mixer graph requires at least one hardware Output")
  const outputMappings = new Set(outputs.map((channel) => channel.hardwareOutputChannels.join(",")))
  if (outputMappings.size !== outputs.length) {
    throw new Error("Hardware Output channel pairs must be unique")
  }
  const edges = new Map(graph.channels.map((channel) => [channel.id, [] as string[]]))
  for (const channel of graph.channels) {
    if (channel.kind === "master" || channel.kind === "output") {
      if (channel.outputChannelId !== null) {
        throw new Error("Master and hardware Outputs cannot route onward")
      }
    } else {
      const output = channel.outputChannelId && channelById(graph, channel.outputChannelId)
      if (!output || (output.kind !== "bus" && output.kind !== "output")) {
        throw new Error("Audio, Instrument, and Bus channels must target a Bus or hardware Output")
      }
      edges.get(channel.id)!.push(output.id)
    }
  }
  const sendIds = new Set<string>()
  for (const send of graph.sends) {
    if (!send.id || sendIds.has(send.id)) throw new Error("Mixer send IDs must be unique")
    if (new TextEncoder().encode(send.id).length > 64) {
      throw new Error("Mixer send IDs must be at most 64 UTF-8 bytes")
    }
    sendIds.add(send.id)
    const source = channelById(graph, send.sourceChannelId)
    const target = channelById(graph, send.targetChannelId)
    if (
      source.kind === "master" || source.kind === "output" ||
      target.kind !== "bus" || source.id === target.id
    ) {
      throw new Error("Sends must route an Audio, Instrument, or Bus channel to a Bus")
    }
    finiteRange(send.levelDb, -90, 12, "Send level")
    finiteRange(send.pan, -1, 1, "Send pan")
    if (!Number.isSafeInteger(send.sortOrder) || send.sortOrder < 0) {
      throw new Error("Mixer send order must be a non-negative safe integer")
    }
    edges.get(source.id)!.push(target.id)
  }
  for (const clip of graph.clips) {
    if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0) {
      throw new Error("Clip start frame must be a non-negative safe integer")
    }
    if (!Number.isSafeInteger(clip.sourceOffsetFrames) || clip.sourceOffsetFrames < 0 ||
        !Number.isSafeInteger(clip.lengthFrames) || clip.lengthFrames < 1) {
      throw new Error("Clip source offset and length must use valid sample frames")
    }
    if (channelById(graph, clip.trackId).kind !== "audio") {
      throw new Error("Timeline clips must belong to audio tracks")
    }
  }
  const pluginIds = new Set<string>()
  const pluginSlots = new Set<string>()
  for (const plugin of graph.plugins) {
    if (!plugin.id || pluginIds.has(plugin.id)) throw new Error("Plugin instance IDs must be unique")
    pluginIds.add(plugin.id)
    const channel = channelById(graph, plugin.channelId)
    if (!Number.isSafeInteger(plugin.slotOrder) || plugin.slotOrder < 0) {
      throw new Error("Plugin slot order must be a non-negative safe integer")
    }
    const slot = `${plugin.channelId}:${plugin.role}:${plugin.slotOrder}`
    if (pluginSlots.has(slot)) throw new Error("Plugin slots must be unique within a channel")
    pluginSlots.add(slot)
    if (plugin.role === "instrument") {
      if (channel.kind !== "instrument" || plugin.slotOrder !== 0 ||
          plugin.descriptor.kind !== "instrument") {
        throw new Error("An instrument slot requires an instrument plugin on an Instrument track")
      }
    } else if (plugin.descriptor.kind !== "effect") {
      throw new Error("Insert slots only accept effect plugins")
    }
    if (plugin.classId !== plugin.descriptor.classId) {
      throw new Error("Plugin class ID must match its descriptor snapshot")
    }
  }
  if (graph.tempoMap.ticksPerQuarter !== 960) {
    throw new Error("Project tempo maps must use 960 PPQ")
  }
  if (graph.tempoMap.tempoEvents[0]?.tick !== 0 ||
      graph.tempoMap.timeSignatureEvents[0]?.tick !== 0) {
    throw new Error("Tempo and time-signature maps require an event at tick 0")
  }
  let previousTempoTick = -1
  for (const event of graph.tempoMap.tempoEvents) {
    if (!Number.isSafeInteger(event.tick) || event.tick <= previousTempoTick ||
        !Number.isFinite(event.beatsPerMinute) || event.beatsPerMinute <= 0) {
      throw new Error("Tempo events must be ordered unique ticks with positive BPM")
    }
    previousTempoTick = event.tick
  }
  let previousSignatureTick = -1
  for (const event of graph.tempoMap.timeSignatureEvents) {
    if (!Number.isSafeInteger(event.tick) || event.tick <= previousSignatureTick ||
        !Number.isInteger(event.numerator) || event.numerator < 1 || event.numerator > 32 ||
        ![1, 2, 4, 8, 16, 32].includes(event.denominator)) {
      throw new Error("Time-signature events contain invalid values")
    }
    previousSignatureTick = event.tick
  }
  const midiClipIds = new Set<string>()
  for (const clip of graph.midiClips) {
    if (!clip.id || midiClipIds.has(clip.id)) throw new Error("MIDI clip IDs must be unique")
    midiClipIds.add(clip.id)
    if (channelById(graph, clip.trackId).kind !== "instrument") {
      throw new Error("MIDI clips must belong to Instrument tracks")
    }
    if (!Number.isSafeInteger(clip.startTick) || clip.startTick < 0 ||
        !Number.isSafeInteger(clip.sourceOffsetTicks) || clip.sourceOffsetTicks < 0 ||
        !Number.isSafeInteger(clip.lengthTicks) || clip.lengthTicks < 1) {
      throw new Error("MIDI clip positions must use valid musical ticks")
    }
    for (const note of clip.notes) {
      if (!Number.isSafeInteger(note.startTick) || note.startTick < 0 ||
          !Number.isSafeInteger(note.durationTicks) || note.durationTicks < 1 ||
          !Number.isInteger(note.channel) || note.channel < 0 || note.channel > 15 ||
          !Number.isInteger(note.key) || note.key < 0 || note.key > 127 ||
          !Number.isInteger(note.velocity) || note.velocity < 1 || note.velocity > 127 ||
          !Number.isInteger(note.releaseVelocity) ||
          note.releaseVelocity < 0 || note.releaseVelocity > 127) {
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

function insertChannel(channel: MixerChannelState): ProjectQueryRequest {
  return {
    sql: `INSERT INTO mixer_channels (
      id, kind, name, color, sort_order, input_format, gain_db, pan, muted,
      soloed, output_channel_id, record_armed, input_channels, hardware_output_channels
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    params: [
      channel.id, channel.kind, channel.name, channel.color, channel.sortOrder,
      channel.inputFormat, channel.gainDb, channel.pan, channel.muted, channel.soloed,
      channel.outputChannelId, channel.recordArmed, `{${channel.inputChannels.join(",")}}`,
      `{${channel.hardwareOutputChannels.join(",")}}`
    ],
    method: "execute"
  }
}

function insertSend(send: MixerSendState): ProjectQueryRequest {
  return {
    sql: `INSERT INTO mixer_sends (
      id, source_channel_id, target_channel_id, sort_order, enabled, tap, level_db, pan
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    params: [
      send.id, send.sourceChannelId, send.targetChannelId, send.sortOrder,
      send.enabled, send.tap, send.levelDb, send.pan
    ],
    method: "execute"
  }
}

function insertClip(clip: TimelineClipState): ProjectQueryRequest {
  return {
    sql: `INSERT INTO timeline_clips (
      id, asset_id, track_id, name, start_frame, source_offset_frames, length_frames
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    params: [
      clip.id, clip.assetId, clip.trackId, clip.name, BigInt(clip.startFrame),
      BigInt(clip.sourceOffsetFrames), BigInt(clip.lengthFrames)
    ],
    method: "execute"
  }
}

function insertPlugin(plugin: PluginInstanceState): ProjectQueryRequest {
  return {
    sql: `INSERT INTO plugin_instances (
      id, channel_id, role, slot_order, class_id, descriptor_snapshot, enabled,
      component_state, controller_state
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    params: [
      plugin.id, plugin.channelId, plugin.role, plugin.slotOrder, plugin.classId,
      JSON.stringify(plugin.descriptor), plugin.enabled,
      plugin.componentState, plugin.controllerState
    ],
    method: "execute"
  }
}

function insertMidiClip(clip: MidiClipState): ProjectQueryRequest[] {
  return [
    {
      sql: `INSERT INTO midi_clips (
        id, source_id, track_id, name, start_tick, length_ticks, source_offset_ticks
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      params: [
        clip.id, clip.sourceId, clip.trackId, clip.name, BigInt(clip.startTick),
        BigInt(clip.lengthTicks), BigInt(clip.sourceOffsetTicks)
      ],
      method: "execute"
    },
    ...clip.notes.map<ProjectQueryRequest>((note) => ({
      sql: `INSERT INTO midi_notes (
        id, clip_id, start_tick, duration_ticks, channel, key, velocity, release_velocity
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      params: [
        note.id, clip.id, BigInt(note.startTick), BigInt(note.durationTicks),
        note.channel, note.key, note.velocity, note.releaseVelocity
      ],
      method: "execute"
    })),
    ...clip.events.map<ProjectQueryRequest>((event) => ({
      sql: `INSERT INTO midi_events (id, clip_id, tick, channel, kind, data)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      params: [event.id, clip.id, BigInt(event.tick), event.channel, event.kind, event.data],
      method: "execute"
    }))
  ]
}

const channelColumns: Record<keyof MixerChannelPatch, string> = {
  name: "name",
  color: "color",
  sortOrder: "sort_order",
  inputFormat: "input_format",
  gainDb: "gain_db",
  pan: "pan",
  muted: "muted",
  soloed: "soloed",
  outputChannelId: "output_channel_id",
  recordArmed: "record_armed",
  inputChannels: "input_channels",
  hardwareOutputChannels: "hardware_output_channels"
}

const sendColumns: Record<keyof MixerSendPatch, string> = {
  targetChannelId: "target_channel_id",
  sortOrder: "sort_order",
  enabled: "enabled",
  tap: "tap",
  levelDb: "level_db",
  pan: "pan"
}

const pluginColumns: Record<keyof PluginInstancePatch, string> = {
  slotOrder: "slot_order",
  enabled: "enabled",
  componentState: "component_state",
  controllerState: "controller_state"
}

function updateQuery(
  table: string,
  id: string,
  patch: Record<string, unknown>,
  columns: Record<string, string>
): ProjectQueryRequest[] {
  const entries = Object.entries(patch)
  if (entries.length === 0) return []
  const values = entries.map(([, value]) =>
    Array.isArray(value) ? `{${value.join(",")}}` : value
  )
  return [{
    sql: `UPDATE ${table} SET ${entries.map(([key], index) =>
      `${columns[key]} = $${index + 1}`).join(", ")} WHERE id = $${entries.length + 1}`,
    params: [...values, id] as ProjectQueryRequest["params"],
    method: "execute"
  }]
}

function commandQueries(command: ProjectCommand, fallbackOutputId: string): ProjectQueryRequest[] {
  switch (command.type) {
    case "create-channel":
      return [insertChannel(command.channel)]
    case "delete-channel":
      return [
        {
          sql: "UPDATE mixer_channels SET output_channel_id = $1 WHERE output_channel_id = $2",
          params: [fallbackOutputId, command.channelId],
          method: "execute"
        },
        {
          sql: "DELETE FROM mixer_sends WHERE target_channel_id = $1",
          params: [command.channelId],
          method: "execute"
        },
        {
          sql: "DELETE FROM mixer_channels WHERE id = $1",
          params: [command.channelId],
          method: "execute"
        }
      ]
    case "update-channel":
      return updateQuery(
        "mixer_channels",
        command.channelId,
        command.patch,
        channelColumns
      )
    case "create-send":
      return [insertSend(command.send)]
    case "delete-send":
      return [{
        sql: "DELETE FROM mixer_sends WHERE id = $1",
        params: [command.sendId],
        method: "execute"
      }]
    case "update-send":
      return updateQuery("mixer_sends", command.sendId, command.patch, sendColumns)
    case "create-clip":
      return [insertClip(command.clip)]
    case "delete-clip":
      return [{
        sql: "DELETE FROM timeline_clips WHERE id = $1",
        params: [command.clipId],
        method: "execute"
      }]
    case "move-clip":
      return [{
        sql: "UPDATE timeline_clips SET track_id = $1, start_frame = $2 WHERE id = $3",
        params: [command.trackId, BigInt(command.startFrame), command.clipId],
        method: "execute"
      }]
    case "create-plugin":
      return [insertPlugin(command.plugin)]
    case "delete-plugin":
      return [{
        sql: "DELETE FROM plugin_instances WHERE id = $1",
        params: [command.pluginId],
        method: "execute"
      }]
    case "update-plugin":
      return updateQuery("plugin_instances", command.pluginId, command.patch, pluginColumns)
    case "move-plugin":
      return [{
        sql: `UPDATE plugin_instances
          SET channel_id = $1, role = $2, slot_order = $3 WHERE id = $4`,
        params: [command.channelId, command.role, command.slotOrder, command.pluginId],
        method: "execute"
      }]
    case "replace-plugin":
      return [
        {
          sql: "DELETE FROM plugin_instances WHERE id = $1",
          params: [command.pluginId],
          method: "execute"
        },
        insertPlugin(command.plugin)
      ]
    case "create-midi-clip":
      return insertMidiClip(command.clip)
    case "delete-midi-clip":
      return [{
        sql: "DELETE FROM midi_clips WHERE id = $1",
        params: [command.clipId],
        method: "execute"
      }]
    case "move-midi-clip":
      return [{
        sql: "UPDATE midi_clips SET track_id = $1, start_tick = $2 WHERE id = $3",
        params: [command.trackId, BigInt(command.startTick), command.clipId],
        method: "execute"
      }]
    case "replace-tempo-map": {
      const initialTempo = command.tempoMap.tempoEvents[0]
      const initialSignature = command.tempoMap.timeSignatureEvents[0]
      if (!initialTempo || !initialSignature) throw new Error("Tempo map requires tick 0 events")
      return [
        { sql: "DELETE FROM tempo_events", params: [], method: "execute" },
        ...command.tempoMap.tempoEvents.map<ProjectQueryRequest>((event) => ({
          sql: "INSERT INTO tempo_events (tick, beats_per_minute) VALUES ($1, $2)",
          params: [BigInt(event.tick), event.beatsPerMinute],
          method: "execute"
        })),
        { sql: "DELETE FROM time_signature_events", params: [], method: "execute" },
        ...command.tempoMap.timeSignatureEvents.map<ProjectQueryRequest>((event) => ({
          sql: `INSERT INTO time_signature_events (tick, numerator, denominator)
            VALUES ($1, $2, $3)`,
          params: [BigInt(event.tick), event.numerator, event.denominator],
          method: "execute"
        })),
        {
          sql: `UPDATE project SET tempo = $1, time_signature_numerator = $2,
            time_signature_denominator = $3 WHERE id = 'project'`,
          params: [
            initialTempo.beatsPerMinute,
            initialSignature.numerator,
            initialSignature.denominator
          ],
          method: "execute"
        }
      ]
    }
    case "batch":
      return command.commands.flatMap((nested) => commandQueries(nested, fallbackOutputId))
  }
}

function onlyRealtimeParameters(command: ProjectCommand): boolean {
  if (command.type === "batch") return command.commands.every(onlyRealtimeParameters)
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
    private readonly onGraphLoaded: (revision: number) => Promise<void> = async () => {}
  ) {
    this.cacheDirectory = join(userData, "mixer-cache")
  }

  private enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(task, task)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  async snapshot(): Promise<MixerGraphSnapshot> {
    const current = this.projects.current
    if (!current) throw new Error("No project is open")
    const [
      channelResult,
      clipResult,
      sendResult,
      pluginResult,
      midiClipResult,
      midiNoteResult,
      midiEventResult,
      tempoResult,
      signatureResult
    ] = await Promise.all([
      this.projects.query({
        sql: `SELECT id, kind, name, color, sort_order, input_format, gain_db, pan,
          muted, soloed, output_channel_id, record_armed, input_channels,
          hardware_output_channels
          FROM mixer_channels
          ORDER BY CASE kind
            WHEN 'audio' THEN 0 WHEN 'instrument' THEN 1 WHEN 'bus' THEN 2
            WHEN 'master' THEN 3 ELSE 4
          END, sort_order, id`,
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: `SELECT c.id, c.asset_id, c.track_id, c.name, c.start_frame, c.source_offset_frames,
          c.length_frames, a.sample_rate, a.channels
          FROM timeline_clips c JOIN assets a ON a.id = c.asset_id
          ORDER BY c.start_frame, c.id`,
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: `SELECT id, source_channel_id, target_channel_id, sort_order, enabled, tap, level_db, pan
          FROM mixer_sends ORDER BY source_channel_id, sort_order, id`,
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: `SELECT id, channel_id, role, slot_order, class_id, descriptor_snapshot,
          enabled, component_state, controller_state
          FROM plugin_instances ORDER BY channel_id, role, slot_order, id`,
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: `SELECT id, source_id, track_id, name, start_tick, length_ticks,
          source_offset_ticks FROM midi_clips ORDER BY start_tick, id`,
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: `SELECT id, clip_id, start_tick, duration_ticks, channel, key, velocity,
          release_velocity FROM midi_notes ORDER BY clip_id, start_tick, id`,
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: `SELECT id, clip_id, tick, channel, kind, data
          FROM midi_events ORDER BY clip_id, tick, id`,
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: "SELECT tick, beats_per_minute FROM tempo_events ORDER BY tick",
        params: [],
        method: "all"
      }),
      this.projects.query({
        sql: `SELECT tick, numerator, denominator
          FROM time_signature_events ORDER BY tick`,
        params: [],
        method: "all"
      })
    ])
    const notesByClip = new Map<string, MidiClipState["notes"]>()
    for (const row of midiNoteResult.rows) {
      const clipId = String(row[1])
      const notes = notesByClip.get(clipId) ?? []
      notes.push({
        id: String(row[0]),
        startTick: Number(row[2]),
        durationTicks: Number(row[3]),
        channel: Number(row[4]),
        key: Number(row[5]),
        velocity: Number(row[6]),
        releaseVelocity: Number(row[7])
      })
      notesByClip.set(clipId, notes)
    }
    const eventsByClip = new Map<string, MidiClipState["events"]>()
    for (const row of midiEventResult.rows) {
      const clipId = String(row[1])
      const events = eventsByClip.get(clipId) ?? []
      events.push({
        id: String(row[0]),
        tick: Number(row[2]),
        channel: row[3] === null ? null : Number(row[3]),
        kind: String(row[4]) as MidiClipState["events"][number]["kind"],
        data: bytes(row[5])
      })
      eventsByClip.set(clipId, events)
    }
    return {
      sampleRate: current.configuration.sampleRate,
      channels: channelResult.rows.map((row) => ({
        id: String(row[0]),
        kind: String(row[1]) as MixerChannelState["kind"],
        name: String(row[2]),
        color: String(row[3]),
        sortOrder: Number(row[4]),
        inputFormat: row[5] === null ? null : String(row[5]) as MixerChannelState["inputFormat"],
        gainDb: Number(row[6]),
        pan: Number(row[7]),
        muted: Boolean(row[8]),
        soloed: Boolean(row[9]),
        outputChannelId: row[10] === null ? null : String(row[10]),
        recordArmed: Boolean(row[11]),
        inputChannels: Array.isArray(row[12]) ? row[12].map(Number) : [],
        hardwareOutputChannels: Array.isArray(row[13]) ? row[13].map(Number) : []
      })),
      clips: clipResult.rows.map((row) => ({
        id: String(row[0]),
        assetId: String(row[1]),
        trackId: String(row[2]),
        name: String(row[3]),
        startFrame: Number(row[4]),
        sourceOffsetFrames: Number(row[5]),
        lengthFrames: Number(row[6]),
        assetSampleRate: Number(row[7]),
        assetChannels: Number(row[8])
      })),
      sends: sendResult.rows.map((row) => ({
        id: String(row[0]),
        sourceChannelId: String(row[1]),
        targetChannelId: String(row[2]),
        sortOrder: Number(row[3]),
        enabled: Boolean(row[4]),
        tap: String(row[5]) as MixerSendState["tap"],
        levelDb: Number(row[6]),
        pan: Number(row[7])
      })),
      plugins: pluginResult.rows.map((row) => ({
        id: String(row[0]),
        channelId: String(row[1]),
        role: String(row[2]) as PluginInstanceState["role"],
        slotOrder: Number(row[3]),
        classId: String(row[4]),
        descriptor: JSON.parse(String(row[5])) as PluginInstanceState["descriptor"],
        enabled: Boolean(row[6]),
        componentState: bytes(row[7]),
        controllerState: bytes(row[8])
      })),
      midiClips: midiClipResult.rows.map((row) => {
        const id = String(row[0])
        return {
          id,
          sourceId: String(row[1]),
          trackId: String(row[2]),
          name: String(row[3]),
          startTick: Number(row[4]),
          lengthTicks: Number(row[5]),
          sourceOffsetTicks: Number(row[6]),
          notes: notesByClip.get(id) ?? [],
          events: eventsByClip.get(id) ?? []
        }
      }),
      tempoMap: {
        ticksPerQuarter: 960,
        tempoEvents: tempoResult.rows.map((row) => ({
          tick: Number(row[0]),
          beatsPerMinute: Number(row[1])
        })),
        timeSignatureEvents: signatureResult.rows.map((row) => ({
          tick: Number(row[0]),
          numerator: Number(row[1]),
          denominator: Number(row[2])
        }))
      }
    }
  }

  private async cacheAssets(graph: MixerGraphSnapshot): Promise<Map<string, string>> {
    await mkdir(this.cacheDirectory, { recursive: true })
    const ids = [...new Set(graph.clips.map((clip) => clip.assetId))]
    const result = new Map<string, string>()
    for (const id of ids) {
      const hashResult = await this.projects.query({
        sql: "SELECT content_hash FROM assets WHERE id = $1",
        params: [id],
        method: "all"
      })
      const row: AssetCacheRow = {
        id,
        contentHash: String(hashResult.rows[0]?.[0] ?? "unknown")
      }
      const safeId = row.id.replace(/[^a-zA-Z0-9_-]/g, "_")
      const path = join(this.cacheDirectory, `${safeId}-${row.contentHash}.bwf`)
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
    const channelIndex = new Map(graph.channels.map((channel, index) => [channel.id, index]))
    const audioIndex = new Map(
      graph.channels
        .filter((channel) => channel.kind === "audio")
        .map((channel, index) => [channel.id, index])
    )
    loadMixerGraph({
      sampleRate: graph.sampleRate,
      channels: graph.channels.map((channel) => ({
        id: channel.id,
        kind: channel.kind,
        gainDb: channel.gainDb,
        pan: channel.pan,
        muted: channel.muted,
        soloed: channel.soloed,
        recordArmed: channel.recordArmed,
        inputChannels: channel.inputChannels,
        hardwareOutputChannels: channel.hardwareOutputChannels,
        outputIndex: channel.outputChannelId === null
          ? undefined
          : channelIndex.get(channel.outputChannelId)
      })),
      sends: graph.sends.map((send) => ({
        id: send.id,
        sourceIndex: channelIndex.get(send.sourceChannelId)!,
        targetIndex: channelIndex.get(send.targetChannelId)!,
        enabled: send.enabled,
        tap: send.tap,
        levelDb: send.levelDb,
        pan: send.pan
      })),
      clips: graph.clips.map((clip) => ({
        id: clip.id,
        trackInputIndex: audioIndex.get(clip.trackId)!,
        startFrame: clip.startFrame,
        sourceOffsetFrames: clip.sourceOffsetFrames,
        lengthFrames: clip.lengthFrames,
        path: paths.get(clip.assetId)!
      }))
    })
    this.graphRevision += 1
    await this.onGraphLoaded(this.graphRevision)
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
      const queries: ProjectQueryRequest[] = [
        {
          sql: `INSERT INTO midi_sources (id, name, content_hash, raw_bytes)
            VALUES ($1, $2, $3, $4)`,
          params: [source.id, source.name, source.contentHash, source.rawBytes],
          method: "execute"
        },
        ...commandQueries(command, fallbackOutput.id)
      ]
      await this.projects.transaction({ queries })
      try {
        await this.loadNow()
      } catch (error) {
        await this.projects.transaction({
          queries: [
            ...commandQueries(inverse, fallbackOutput.id),
            {
              sql: "DELETE FROM midi_sources WHERE id = $1",
              params: [source.id],
              method: "execute"
            }
          ]
        })
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
    const fallbackOutput = before.channels.find((channel) =>
      channel.kind === "output" && !deletedIds.has(channel.id)
    )
    if (!fallbackOutput) throw new Error("Mixer hardware Output is missing")
    const queries = commandQueries(command, fallbackOutput.id)
    if (queries.length > 0) await this.projects.transaction({ queries })
    try {
      if (onlyRealtimeParameters(command)) {
        await this.previewCommitted(command)
      } else {
        await this.loadNow()
      }
    } catch (error) {
      const rollback = commandQueries(inverse, fallbackOutput.id)
      if (rollback.length > 0) await this.projects.transaction({ queries: rollback })
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
        previewMixerParameter({
          target: "channel", id: command.channelId, parameter: "gainDb", value: command.patch.gainDb
        })
      }
      if (command.patch.pan !== undefined) {
        previewMixerParameter({
          target: "channel", id: command.channelId, parameter: "pan", value: command.patch.pan
        })
      }
    } else if (command.type === "update-send") {
      if (command.patch.levelDb !== undefined) {
        previewMixerParameter({
          target: "send", id: command.sendId, parameter: "levelDb", value: command.patch.levelDb
        })
      }
      if (command.patch.pan !== undefined) {
        previewMixerParameter({
          target: "send", id: command.sendId, parameter: "pan", value: command.patch.pan
        })
      }
    }
  }

  preview(preview: MixerParameterPreview): void {
    finiteRange(
      preview.value,
      preview.parameter === "pan" ? -1 : -90,
      preview.parameter === "pan" ? 1 : 12,
      "Mixer preview"
    )
    previewMixerParameter(preview)
  }

  runtimeSnapshot(): MixerRuntimeSnapshot {
    return {
      meters: mixerSnapshot().meters.map((meter) => ({
        channelId: meter.channelId,
        preFaderPeak: [meter.preLeft, meter.preRight],
        postFaderPeak: [meter.postLeft, meter.postRight],
        heldPeak: [meter.heldLeft, meter.heldRight],
        clipped: meter.clipped
      })),
      capturedAt: Date.now()
    }
  }

  clearMeterClips(): MixerRuntimeSnapshot {
    transportCommand("clear-meter-clips")
    return this.runtimeSnapshot()
  }

  transport(command: TransportCommand): TransportSnapshot {
    if (process.env.YADAW_TEST_CAPTURE_SOURCE === "1") {
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
    const native = command.type === "seek"
      ? transportCommand("seek", command.positionFrames)
      : transportCommand(command.type)
    return {
      state: native.state as TransportSnapshot["state"],
      positionFrames: native.positionFrames,
      sampleRate: native.sampleRate
    }
  }

  transportSnapshot(): TransportSnapshot {
    if (process.env.YADAW_TEST_CAPTURE_SOURCE === "1") {
      return { ...this.testTransport }
    }
    const native = transportSnapshot()
    return {
      state: native.state as TransportSnapshot["state"],
      positionFrames: native.positionFrames,
      sampleRate: native.sampleRate
    }
  }
}

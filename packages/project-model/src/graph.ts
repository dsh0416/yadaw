import type {
  AudioClipState,
  MidiClipState,
  MixerChannelState,
  MixerSendState,
  PluginInstanceState,
  ProjectCommand,
  ProjectGraphSnapshot,
  TrackState
} from "@heron/contracts"

export function finiteRange(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new TypeError(`${label} must be between ${minimum} and ${maximum}`)
  }
}

export function cloneGraph(graph: ProjectGraphSnapshot): ProjectGraphSnapshot {
  return structuredClone(graph)
}

function channelById(graph: ProjectGraphSnapshot, id: string): MixerChannelState {
  const channel = graph.channels.find((candidate) => candidate.id === id)
  if (!channel) throw new Error(`Mixer channel '${id}' was not found`)
  return channel
}

function trackById(graph: ProjectGraphSnapshot, id: string): TrackState {
  const track = graph.tracks.find((candidate) => candidate.id === id)
  if (!track) throw new Error(`Project track '${id}' was not found`)
  return track
}

function channelForTrack(graph: ProjectGraphSnapshot, trackId: string): MixerChannelState {
  return channelById(graph, trackById(graph, trackId).channelId)
}

function sendById(graph: ProjectGraphSnapshot, id: string): MixerSendState {
  const send = graph.sends.find((candidate) => candidate.id === id)
  if (!send) throw new Error(`Mixer send '${id}' was not found`)
  return send
}

function clipById(graph: ProjectGraphSnapshot, id: string): AudioClipState {
  const clip = graph.audioClips.find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`Timeline clip '${id}' was not found`)
  return clip
}

function pluginById(graph: ProjectGraphSnapshot, id: string): PluginInstanceState {
  const plugin = graph.plugins.find((candidate) => candidate.id === id)
  if (!plugin) throw new Error(`Plugin instance '${id}' was not found`)
  return plugin
}

function sidechainRoutesFromChannel(
  graph: ProjectGraphSnapshot,
  channelId: string,
  excludingPluginIds: ReadonlySet<string> = new Set()
): ProjectCommand[] {
  return graph.plugins
    .filter(
      (plugin) =>
        !excludingPluginIds.has(plugin.id) &&
        plugin.sidechainInputs.some((route) => route.sourceChannelId === channelId)
    )
    .map((plugin) => ({
      type: "update-plugin" as const,
      pluginId: plugin.id,
      patch: { sidechainInputs: structuredClone(plugin.sidechainInputs) }
    }))
}

function midiClipById(graph: ProjectGraphSnapshot, id: string): MidiClipState {
  const clip = graph.midiClips.find((candidate) => candidate.id === id)
  if (!clip) throw new Error(`MIDI clip '${id}' was not found`)
  return clip
}

function midiNoteById(clip: MidiClipState, id: string): MidiClipState["notes"][number] {
  const note = clip.notes.find((candidate) => candidate.id === id)
  if (!note) throw new Error(`MIDI note '${id}' was not found in clip '${clip.id}'`)
  return note
}

function movePluginInGraph(
  graph: ProjectGraphSnapshot,
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

export function inverseFor(graph: ProjectGraphSnapshot, command: ProjectCommand): ProjectCommand {
  switch (command.type) {
    case "update-project-notes":
      return { type: "update-project-notes", notes: graph.projectNotes ?? "" }
    case "create-track":
      return { type: "delete-track", trackId: command.track.id }
    case "delete-track": {
      const track = trackById(graph, command.trackId)
      const channel = channelById(graph, track.channelId)
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
      const audioClips = graph.audioClips
        .filter((clip) => clip.trackId === track.id)
        .map<ProjectCommand>((clip) => ({ type: "create-audio-clip", clip }))
      const plugins = graph.plugins
        .filter((plugin) => plugin.channelId === channel.id)
        .map<ProjectCommand>((plugin) => ({ type: "create-plugin", plugin }))
      const pluginIds = new Set(
        graph.plugins.filter((plugin) => plugin.channelId === channel.id).map((plugin) => plugin.id)
      )
      const sidechainRoutes = sidechainRoutesFromChannel(graph, channel.id, pluginIds)
      const midiClips = graph.midiClips
        .filter((clip) => clip.trackId === track.id)
        .map<ProjectCommand>((clip) => ({ type: "create-midi-clip", clip }))
      return {
        type: "batch",
        commands: [
          { type: "create-track", track, channel },
          ...affectedOutputs,
          ...sends,
          ...audioClips,
          ...plugins,
          ...sidechainRoutes,
          ...midiClips
        ]
      }
    }
    case "update-track": {
      const track = trackById(graph, command.trackId)
      return {
        type: "update-track",
        trackId: command.trackId,
        patch: patchFromKeys(track, command.patch)
      }
    }
    case "create-channel":
      return { type: "delete-channel", channelId: command.channel.id }
    case "delete-channel": {
      const channel = channelById(graph, command.channelId)
      if (graph.tracks.some((track) => track.channelId === channel.id)) {
        throw new Error("Track-owned channels must be deleted through delete-track")
      }
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
      const plugins = graph.plugins
        .filter((plugin) => plugin.channelId === channel.id)
        .map<ProjectCommand>((plugin) => ({ type: "create-plugin", plugin }))
      const pluginIds = new Set(
        graph.plugins.filter((plugin) => plugin.channelId === channel.id).map((plugin) => plugin.id)
      )
      const sidechainRoutes = sidechainRoutesFromChannel(graph, channel.id, pluginIds)
      return {
        type: "batch",
        commands: [
          { type: "create-channel", channel },
          ...affectedOutputs,
          ...sends,
          ...plugins,
          ...sidechainRoutes
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
    case "create-audio-clip":
      return { type: "delete-audio-clip", clipId: command.clip.id }
    case "delete-audio-clip":
      return { type: "create-audio-clip", clip: clipById(graph, command.clipId) }
    case "move-audio-clip": {
      const clip = clipById(graph, command.clipId)
      return {
        type: "move-audio-clip",
        clipId: command.clipId,
        trackId: clip.trackId,
        startFrame: clip.startFrame
      }
    }
    case "update-audio-clip": {
      const clip = clipById(graph, command.clipId)
      return {
        type: "update-audio-clip",
        clipId: clip.id,
        patch: patchFromKeys(clip, command.patch)
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
    case "create-midi-source":
      return { type: "delete-midi-source", source: structuredClone(command.source) }
    case "delete-midi-source":
      return { type: "create-midi-source", source: structuredClone(command.source) }
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
    case "update-midi-clip-range": {
      const clip = midiClipById(graph, command.clipId)
      return {
        type: "update-midi-clip-range",
        clipId: clip.id,
        patch: patchFromKeys(clip, command.patch)
      }
    }
    case "create-midi-notes":
      return {
        type: "delete-midi-notes",
        clipId: command.clipId,
        noteIds: command.notes.map((note) => note.id)
      }
    case "delete-midi-notes": {
      const clip = midiClipById(graph, command.clipId)
      return {
        type: "create-midi-notes",
        clipId: clip.id,
        notes: command.noteIds.map((noteId) => structuredClone(midiNoteById(clip, noteId)))
      }
    }
    case "update-midi-notes": {
      const clip = midiClipById(graph, command.clipId)
      return {
        type: "update-midi-notes",
        clipId: clip.id,
        updates: command.updates.map(({ noteId, patch }) => ({
          noteId,
          patch: patchFromKeys(midiNoteById(clip, noteId), patch)
        }))
      }
    }
    case "rebase-midi-clip-content":
      midiClipById(graph, command.clipId)
      return {
        type: "rebase-midi-clip-content",
        clipId: command.clipId,
        deltaTicks: -command.deltaTicks
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

export function applyToGraph(
  graph: ProjectGraphSnapshot,
  command: ProjectCommand
): ProjectGraphSnapshot {
  const next = cloneGraph(graph)
  switch (command.type) {
    case "update-project-notes":
      next.projectNotes = command.notes
      break
    case "create-track":
      next.channels.push(structuredClone(command.channel))
      next.tracks.push(structuredClone(command.track))
      break
    case "delete-track": {
      const track = trackById(next, command.trackId)
      next.tracks = next.tracks.filter((candidate) => candidate.id !== track.id)
      next.audioClips = next.audioClips.filter((clip) => clip.trackId !== track.id)
      next.midiClips = next.midiClips.filter((clip) => clip.trackId !== track.id)
      return applyToGraph(next, { type: "delete-channel", channelId: track.channelId })
    }
    case "update-track":
      Object.assign(trackById(next, command.trackId), command.patch)
      break
    case "create-channel":
      next.channels.push(structuredClone(command.channel))
      break
    case "delete-channel": {
      const master = next.channels.find((channel) => channel.kind === "master")
      if (!master || command.channelId === master.id) throw new Error("Master cannot be deleted")
      const removed = channelById(next, command.channelId)
      if (next.tracks.some((track) => track.channelId === removed.id)) {
        throw new Error("Track-owned channels must be deleted through delete-track")
      }
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
      next.plugins = next.plugins.filter((plugin) => plugin.channelId !== command.channelId)
      for (const plugin of next.plugins) {
        plugin.sidechainInputs = plugin.sidechainInputs.filter(
          (route) => route.sourceChannelId !== command.channelId
        )
      }
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
    case "create-audio-clip":
      next.audioClips.push(structuredClone(command.clip))
      break
    case "delete-audio-clip":
      next.audioClips = next.audioClips.filter((clip) => clip.id !== command.clipId)
      break
    case "move-audio-clip": {
      const clip = clipById(next, command.clipId)
      clip.trackId = command.trackId
      clip.startFrame = command.startFrame
      break
    }
    case "update-audio-clip":
      Object.assign(clipById(next, command.clipId), command.patch)
      break
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
    case "create-midi-source":
    case "delete-midi-source":
      break
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
    case "update-midi-clip-range":
      Object.assign(midiClipById(next, command.clipId), command.patch)
      break
    case "create-midi-notes":
      midiClipById(next, command.clipId).notes.push(...structuredClone(command.notes))
      break
    case "delete-midi-notes": {
      const clip = midiClipById(next, command.clipId)
      const ids = new Set(command.noteIds)
      for (const id of ids) midiNoteById(clip, id)
      clip.notes = clip.notes.filter((note) => !ids.has(note.id))
      break
    }
    case "update-midi-notes": {
      const clip = midiClipById(next, command.clipId)
      for (const update of command.updates) {
        Object.assign(midiNoteById(clip, update.noteId), update.patch)
      }
      break
    }
    case "rebase-midi-clip-content": {
      const clip = midiClipById(next, command.clipId)
      for (const note of clip.notes) note.startTick += command.deltaTicks
      for (const event of clip.events) event.tick += command.deltaTicks
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

export function validateGraph(graph: ProjectGraphSnapshot): void {
  if (typeof graph.projectNotes !== "undefined" && typeof graph.projectNotes !== "string") {
    throw new Error("Project notes must be text")
  }
  const trackIds = new Set<string>()
  const tracksByChannel = new Map<string, TrackState>()
  for (const track of graph.tracks) {
    if (!track.id || trackIds.has(track.id)) throw new Error("Project track IDs must be unique")
    if (new TextEncoder().encode(track.id).length > 64) {
      throw new Error("Project track IDs must be at most 64 UTF-8 bytes")
    }
    if (!Number.isSafeInteger(track.sortOrder) || track.sortOrder < 0) {
      throw new Error("Project track order must be a non-negative safe integer")
    }
    if (typeof track.notes !== "undefined" && typeof track.notes !== "string") {
      throw new Error("Track notes must be text")
    }
    if (tracksByChannel.has(track.channelId)) {
      throw new Error("A mixer channel can belong to at most one project track")
    }
    const channel = channelById(graph, track.channelId)
    if (
      channel.systemRole !== null ||
      (channel.kind !== "audio" && channel.kind !== "instrument")
    ) {
      throw new Error("Project tracks must reference ordinary Audio or Instrument channels")
    }
    trackIds.add(track.id)
    tracksByChannel.set(track.channelId, track)
  }

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
    const supportsMidiInput = channel.kind === "instrument" && channel.systemRole === null
    const midiInput =
      channel.midiInput === undefined
        ? supportsMidiInput
          ? { portId: null, portName: null, channel: null }
          : null
        : channel.midiInput
    if (supportsMidiInput) {
      if (midiInput === null) {
        throw new Error("Instrument tracks require a MIDI input route")
      }
      const hasPortId = midiInput.portId !== null
      const hasPortName = midiInput.portName !== null
      if (
        hasPortId !== hasPortName ||
        (hasPortId && !midiInput.portId?.trim()) ||
        (hasPortName && !midiInput.portName?.trim()) ||
        (midiInput.channel !== null &&
          (!Number.isInteger(midiInput.channel) || midiInput.channel < 0 || midiInput.channel > 15))
      ) {
        throw new Error("Instrument MIDI routes require a valid port and channel")
      }
    } else if (midiInput !== null) {
      throw new Error("Only ordinary Instrument tracks can map MIDI inputs")
    }
    if (channel.kind !== "audio" && !supportsMidiInput && channel.recordArmed) {
      throw new Error("Only Audio and ordinary Instrument tracks can arm recording")
    }
    if (channel.kind !== "audio" && !supportsMidiInput && channel.inputMonitoring) {
      throw new Error("Only Audio and ordinary Instrument tracks can enable input monitoring")
    }
    if (channel.kind === "master" && channel.soloed) {
      throw new Error("Master cannot be soloed")
    }
    if (channel.systemRole !== null && channel.kind !== "instrument") {
      throw new Error("System channels must be Instrument channels")
    }
    const shouldOwnTrack =
      channel.systemRole === null && (channel.kind === "audio" || channel.kind === "instrument")
    if (tracksByChannel.has(channel.id) !== shouldOwnTrack) {
      throw new Error(
        shouldOwnTrack
          ? "Ordinary Audio and Instrument channels require exactly one project track"
          : "Aux, Master, Output, and system channels cannot own project tracks"
      )
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
  for (const clip of graph.audioClips) {
    if (!Number.isSafeInteger(clip.startFrame) || clip.startFrame < 0) {
      throw new Error("Clip start frame must be a non-negative safe integer")
    }
    if (
      !Number.isSafeInteger(clip.sourceOffsetFrames) ||
      clip.sourceOffsetFrames < 0 ||
      !Number.isSafeInteger(clip.lengthFrames) ||
      clip.lengthFrames < 1 ||
      !Number.isSafeInteger(clip.sourceLengthFrames) ||
      clip.sourceLengthFrames < 1 ||
      clip.sourceOffsetFrames + clip.lengthFrames > clip.sourceLengthFrames ||
      !Number.isSafeInteger(clip.fadeInFrames) ||
      clip.fadeInFrames < 0 ||
      !Number.isSafeInteger(clip.fadeOutFrames) ||
      clip.fadeOutFrames < 0 ||
      clip.fadeInFrames + clip.fadeOutFrames > clip.lengthFrames
    ) {
      throw new Error("Clip source offset and length must use valid sample frames")
    }
    const channel = channelForTrack(graph, clip.trackId)
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
    const sidechainBusIndices = new Set<number>()
    for (const route of plugin.sidechainInputs) {
      if (!Number.isSafeInteger(route.inputBusIndex) || route.inputBusIndex < 0) {
        throw new Error("Plugin side-chain bus indices must be non-negative safe integers")
      }
      if (sidechainBusIndices.has(route.inputBusIndex)) {
        throw new Error("Each plugin aux input bus can have at most one side-chain source")
      }
      sidechainBusIndices.add(route.inputBusIndex)
      const bus = plugin.descriptor.buses.find(
        (candidate) =>
          candidate.direction === "input" &&
          candidate.kind === "aux" &&
          candidate.index === route.inputBusIndex
      )
      if (!bus || (bus.channels !== 1 && bus.channels !== 2)) {
        throw new Error("Plugin side-chain routes must target an exposed mono or stereo aux bus")
      }
      const source = channelById(graph, route.sourceChannelId)
      const isOrdinaryTrack =
        source.systemRole === null && (source.kind === "audio" || source.kind === "instrument")
      if ((!isOrdinaryTrack && source.kind !== "aux") || source.systemRole !== null) {
        throw new Error(
          "Plugin side-chain sources must be ordinary Audio, Instrument, or Aux channels"
        )
      }
      if (source.id === channel.id) {
        throw new Error("A plugin cannot use its own channel as a side-chain source")
      }
      edges.get(source.id)!.push(channel.id)
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
  const midiNoteIds = new Set<string>()
  const midiEventIds = new Set<string>()
  for (const clip of graph.midiClips) {
    if (!clip.id || midiClipIds.has(clip.id)) throw new Error("MIDI clip IDs must be unique")
    midiClipIds.add(clip.id)
    const channel = channelForTrack(graph, clip.trackId)
    if (channel.kind !== "instrument" || channel.systemRole !== null) {
      throw new Error("MIDI clips must belong to Instrument tracks")
    }
    if (
      !Number.isSafeInteger(clip.startTick) ||
      clip.startTick < 0 ||
      !Number.isSafeInteger(clip.sourceOffsetTicks) ||
      clip.sourceOffsetTicks < 0 ||
      !Number.isSafeInteger(clip.lengthTicks) ||
      clip.lengthTicks < 1 ||
      !Number.isSafeInteger(clip.sourceLengthTicks) ||
      clip.sourceLengthTicks < 1 ||
      clip.sourceOffsetTicks + clip.lengthTicks > clip.sourceLengthTicks
    ) {
      throw new Error("MIDI clip positions must use valid musical ticks")
    }
    for (const note of clip.notes) {
      if (!note.id || midiNoteIds.has(note.id)) throw new Error("MIDI note IDs must be unique")
      midiNoteIds.add(note.id)
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
    for (const event of clip.events) {
      if (!event.id || midiEventIds.has(event.id)) throw new Error("MIDI event IDs must be unique")
      midiEventIds.add(event.id)
      if (!Number.isSafeInteger(event.tick) || event.tick < 0) {
        throw new Error("MIDI event ticks must use 1/3840-note integer resolution")
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

export function onlyRealtimeParameters(command: ProjectCommand): boolean {
  if (command.type === "batch") return command.commands.every(onlyRealtimeParameters)
  if (command.type === "update-project-notes") return true
  if (command.type === "replace-key-signature-map") return true
  if (command.type === "update-track") {
    return Object.keys(command.patch).every((key) => key === "notes")
  }
  if (command.type === "update-channel") {
    return Object.keys(command.patch).every((key) => key === "gainDb" || key === "pan")
  }
  if (command.type === "update-send") {
    return Object.keys(command.patch).every((key) => key === "levelDb" || key === "pan")
  }
  return false
}

export function deletedChannelIds(
  graph: ProjectGraphSnapshot,
  command: ProjectCommand
): Set<string> {
  if (command.type === "delete-track") {
    return new Set([trackById(graph, command.trackId).channelId])
  }
  if (command.type === "delete-channel") return new Set([command.channelId])
  if (command.type !== "batch") return new Set()
  return new Set(command.commands.flatMap((nested) => [...deletedChannelIds(graph, nested)]))
}

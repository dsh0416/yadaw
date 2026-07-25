import { access, mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  MixerGraphSnapshot,
  MixerParameterPreview,
  MixerRuntimeSnapshot,
  MixerSendPatch,
  MixerSendState,
  MixerChannelPatch,
  MixerChannelState,
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
      return {
        type: "batch",
        commands: [
          { type: "create-channel", channel },
          ...affectedOutputs,
          ...sends,
          ...clips
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
        throw new Error("Audio and Bus channels must target a Bus or hardware Output")
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
      throw new Error("Sends must route an Audio or Bus channel to a Bus")
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
  private testTransport: TransportSnapshot = {
    state: "stopped",
    positionFrames: 0,
    sampleRate: 48_000
  }

  constructor(
    userData: string,
    private readonly projects: ProjectService
  ) {
    this.cacheDirectory = join(userData, "mixer-cache")
  }

  async snapshot(): Promise<MixerGraphSnapshot> {
    const current = this.projects.current
    if (!current) throw new Error("No project is open")
    const [channelResult, clipResult, sendResult] = await Promise.all([
      this.projects.query({
        sql: `SELECT id, kind, name, color, sort_order, input_format, gain_db, pan,
          muted, soloed, output_channel_id, record_armed, input_channels,
          hardware_output_channels
          FROM mixer_channels
          ORDER BY CASE kind
            WHEN 'audio' THEN 0 WHEN 'bus' THEN 1 WHEN 'master' THEN 2 ELSE 3
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
      })
    ])
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
      }))
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

  async load(): Promise<MixerGraphSnapshot> {
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
    return graph
  }

  async execute(command: ProjectCommand): Promise<ProjectCommandResult> {
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
        await this.load()
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

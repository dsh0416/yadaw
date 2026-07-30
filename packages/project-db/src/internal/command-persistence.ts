import { and, eq, inArray, ne } from "drizzle-orm"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import {
  normalizePluginDescriptor,
  type MidiClipRangePatch,
  type MidiNotePatch,
  type MixerChannelPatch,
  type MixerSendPatch,
  type PluginDescriptor,
  type PluginInstancePatch,
  type ProjectCommand
} from "@yadaw/contracts"
import {
  keySignatureEvents,
  midiClips,
  midiEvents,
  midiNotes,
  midiSources,
  mixerChannels,
  mixerSends,
  pluginInstances,
  tempoEvents,
  timeSignatureEvents,
  timelineClips
} from "../schema"
import * as schema from "../schema"

type ProjectDb = PgliteDatabase<typeof schema>
type ProjectTransaction = Parameters<Parameters<ProjectDb["transaction"]>[0]>[0]

export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array()
}

export function pluginDescriptor(snapshot: string): PluginDescriptor {
  return normalizePluginDescriptor(JSON.parse(snapshot) as PluginDescriptor & { category?: string })
}

function channelPatch(patch: MixerChannelPatch): Partial<typeof mixerChannels.$inferInsert> {
  const result: Partial<typeof mixerChannels.$inferInsert> = {}
  if (patch.name !== undefined) result.name = patch.name
  if (patch.color !== undefined) result.color = patch.color
  if (patch.sortOrder !== undefined) result.sortOrder = patch.sortOrder
  if (patch.inputSource !== undefined) result.inputSource = patch.inputSource
  if (patch.inputFormat !== undefined) result.inputFormat = patch.inputFormat
  if (patch.midiInput !== undefined) {
    result.midiInputPortId = patch.midiInput?.portId ?? null
    result.midiInputPortName = patch.midiInput?.portName ?? null
    result.midiInputChannel = patch.midiInput?.channel ?? null
  }
  if (patch.gainDb !== undefined) result.gainDb = patch.gainDb
  if (patch.pan !== undefined) result.pan = patch.pan
  if (patch.muted !== undefined) result.muted = patch.muted
  if (patch.soloed !== undefined) result.soloed = patch.soloed
  if (patch.outputChannelId !== undefined) result.outputChannelId = patch.outputChannelId
  if (patch.outputBus !== undefined) result.outputBus = patch.outputBus
  if (patch.recordArmed !== undefined) result.recordArmed = patch.recordArmed
  if (patch.inputMonitoring !== undefined) result.inputMonitoring = patch.inputMonitoring
  if (patch.inputChannels !== undefined) result.inputChannels = patch.inputChannels
  if (patch.hardwareOutputChannels !== undefined) {
    result.hardwareOutputChannels = patch.hardwareOutputChannels
  }
  return result
}

function sendPatch(patch: MixerSendPatch): Partial<typeof mixerSends.$inferInsert> {
  const result: Partial<typeof mixerSends.$inferInsert> = {}
  if (patch.targetChannelId !== undefined) result.targetChannelId = patch.targetChannelId
  if (patch.targetBus !== undefined) result.targetBus = patch.targetBus
  if (patch.sortOrder !== undefined) result.sortOrder = patch.sortOrder
  if (patch.enabled !== undefined) result.enabled = patch.enabled
  if (patch.tap !== undefined) result.tap = patch.tap
  if (patch.levelDb !== undefined) result.levelDb = patch.levelDb
  return result
}

function pluginPatch(patch: PluginInstancePatch): Partial<typeof pluginInstances.$inferInsert> {
  const result: Partial<typeof pluginInstances.$inferInsert> = {}
  if (patch.slotOrder !== undefined) result.slotOrder = patch.slotOrder
  if (patch.enabled !== undefined) result.enabled = patch.enabled
  if (patch.componentState !== undefined) result.componentState = patch.componentState
  if (patch.controllerState !== undefined) result.controllerState = patch.controllerState
  if (patch.araDocumentState !== undefined) result.araDocumentState = patch.araDocumentState
  return result
}

function midiClipRangePatch(patch: MidiClipRangePatch): Partial<typeof midiClips.$inferInsert> {
  const result: Partial<typeof midiClips.$inferInsert> = {}
  if (patch.startTick !== undefined) result.startTick = patch.startTick
  if (patch.lengthTicks !== undefined) result.lengthTicks = patch.lengthTicks
  if (patch.sourceOffsetTicks !== undefined) result.sourceOffsetTicks = patch.sourceOffsetTicks
  return result
}

function midiNotePatch(patch: MidiNotePatch): Partial<typeof midiNotes.$inferInsert> {
  const result: Partial<typeof midiNotes.$inferInsert> = {}
  if (patch.startTick !== undefined) result.startTick = patch.startTick
  if (patch.durationTicks !== undefined) result.durationTicks = patch.durationTicks
  if (patch.channel !== undefined) result.channel = patch.channel
  if (patch.key !== undefined) result.key = patch.key
  if (patch.velocity !== undefined) result.velocity = patch.velocity
  if (patch.releaseVelocity !== undefined) result.releaseVelocity = patch.releaseVelocity
  return result
}

function channelValue(
  channel: Extract<ProjectCommand, { type: "create-channel" }>["channel"]
): typeof mixerChannels.$inferInsert {
  return {
    id: channel.id,
    kind: channel.kind,
    systemRole: channel.systemRole,
    name: channel.name,
    color: channel.color,
    sortOrder: channel.sortOrder,
    inputSource: channel.inputSource,
    inputFormat: channel.inputFormat,
    midiInputPortId: channel.midiInput?.portId ?? null,
    midiInputPortName: channel.midiInput?.portName ?? null,
    midiInputChannel: channel.midiInput?.channel ?? null,
    gainDb: channel.gainDb,
    pan: channel.pan,
    muted: channel.muted,
    soloed: channel.soloed,
    outputChannelId: channel.outputChannelId,
    outputBus: channel.outputBus ?? null,
    recordArmed: channel.recordArmed,
    inputMonitoring: channel.inputMonitoring,
    inputChannels: channel.inputChannels,
    hardwareOutputChannels: channel.hardwareOutputChannels
  }
}

function sendValue(
  send: Extract<ProjectCommand, { type: "create-send" }>["send"]
): typeof mixerSends.$inferInsert {
  return {
    id: send.id,
    sourceChannelId: send.sourceChannelId,
    targetChannelId: send.targetChannelId ?? null,
    targetBus: send.targetBus,
    sortOrder: send.sortOrder,
    enabled: send.enabled,
    tap: send.tap,
    levelDb: send.levelDb
  }
}

function clipValue(
  clip: Extract<ProjectCommand, { type: "create-clip" }>["clip"]
): typeof timelineClips.$inferInsert {
  return {
    id: clip.id,
    assetId: clip.assetId,
    trackId: clip.trackId,
    name: clip.name,
    startFrame: BigInt(clip.startFrame),
    sourceOffsetFrames: BigInt(clip.sourceOffsetFrames),
    lengthFrames: BigInt(clip.lengthFrames)
  }
}

function pluginValue(
  plugin: Extract<ProjectCommand, { type: "create-plugin" }>["plugin"]
): typeof pluginInstances.$inferInsert {
  return {
    id: plugin.id,
    channelId: plugin.channelId,
    role: plugin.role,
    slotOrder: plugin.slotOrder,
    classId: plugin.classId,
    descriptorSnapshot: JSON.stringify(plugin.descriptor),
    audioMode: plugin.audioMode,
    enabled: plugin.enabled,
    componentState: plugin.componentState,
    controllerState: plugin.controllerState,
    araDocumentState: plugin.araDocumentState ?? new Uint8Array()
  }
}

async function insertMidiClip(
  tx: ProjectTransaction,
  clip: Extract<ProjectCommand, { type: "create-midi-clip" }>["clip"]
): Promise<void> {
  await tx.insert(midiClips).values({
    id: clip.id,
    sourceId: clip.sourceId,
    trackId: clip.trackId,
    name: clip.name,
    startTick: clip.startTick,
    lengthTicks: clip.lengthTicks,
    sourceOffsetTicks: clip.sourceOffsetTicks
  })
  if (clip.notes.length > 0) {
    await tx.insert(midiNotes).values(
      clip.notes.map((note) => ({
        id: note.id,
        clipId: clip.id,
        startTick: note.startTick,
        durationTicks: note.durationTicks,
        channel: note.channel,
        key: note.key,
        velocity: note.velocity,
        releaseVelocity: note.releaseVelocity
      }))
    )
  }
  if (clip.events.length > 0) {
    await tx.insert(midiEvents).values(
      clip.events.map((event) => ({
        id: event.id,
        clipId: clip.id,
        tick: event.tick,
        channel: event.channel,
        kind: event.kind,
        data: event.data
      }))
    )
  }
}

export async function applyProjectCommand(
  tx: ProjectTransaction,
  command: ProjectCommand,
  fallbackOutputId: string
): Promise<void> {
  switch (command.type) {
    case "create-channel":
      await tx.insert(mixerChannels).values(channelValue(command.channel))
      return
    case "delete-channel":
      await tx
        .update(mixerChannels)
        .set({ outputChannelId: fallbackOutputId, outputBus: null })
        .where(eq(mixerChannels.outputChannelId, command.channelId))
      await tx.delete(mixerChannels).where(eq(mixerChannels.id, command.channelId))
      return
    case "update-channel": {
      const patch = channelPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(mixerChannels).set(patch).where(eq(mixerChannels.id, command.channelId))
      }
      return
    }
    case "create-send":
      await tx.insert(mixerSends).values(sendValue(command.send))
      return
    case "delete-send":
      await tx.delete(mixerSends).where(eq(mixerSends.id, command.sendId))
      return
    case "update-send": {
      const patch = sendPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(mixerSends).set(patch).where(eq(mixerSends.id, command.sendId))
      }
      return
    }
    case "create-clip":
      await tx.insert(timelineClips).values(clipValue(command.clip))
      return
    case "delete-clip":
      await tx.delete(timelineClips).where(eq(timelineClips.id, command.clipId))
      return
    case "move-clip":
      await tx
        .update(timelineClips)
        .set({ trackId: command.trackId, startFrame: BigInt(command.startFrame) })
        .where(eq(timelineClips.id, command.clipId))
      return
    case "create-plugin":
      await tx.insert(pluginInstances).values(pluginValue(command.plugin))
      return
    case "delete-plugin":
      await tx.delete(pluginInstances).where(eq(pluginInstances.id, command.pluginId))
      return
    case "update-plugin": {
      const patch = pluginPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(pluginInstances).set(patch).where(eq(pluginInstances.id, command.pluginId))
      }
      return
    }
    case "move-plugin":
      {
        const rows = await tx
          .select({
            id: pluginInstances.id,
            channelId: pluginInstances.channelId,
            role: pluginInstances.role,
            slotOrder: pluginInstances.slotOrder
          })
          .from(pluginInstances)
        const moving = rows.find((plugin) => plugin.id === command.pluginId)
        if (!moving) throw new Error(`Plugin instance '${command.pluginId}' was not found`)
        const source = rows
          .filter(
            (plugin) =>
              plugin.id !== moving.id &&
              plugin.channelId === moving.channelId &&
              plugin.role === moving.role
          )
          .sort((left, right) => left.slotOrder - right.slotOrder)
        const destination = rows
          .filter(
            (plugin) =>
              plugin.id !== moving.id &&
              plugin.channelId === command.channelId &&
              plugin.role === command.role
          )
          .sort((left, right) => left.slotOrder - right.slotOrder)
        if (command.role === "instrument" && destination.length > 0) {
          throw new Error("Replace the assigned instrument instead of moving into an occupied slot")
        }
        const insertionIndex =
          command.role === "instrument"
            ? 0
            : Math.max(0, Math.min(command.slotOrder, destination.length))
        destination.splice(insertionIndex, 0, {
          ...moving,
          channelId: command.channelId,
          role: command.role,
          slotOrder: insertionIndex
        })

        // Vacate every affected unique slot before assigning compact final positions.
        const affected = new Set([
          moving.id,
          ...source.map((plugin) => plugin.id),
          ...destination.map((plugin) => plugin.id)
        ])
        let temporarySlot = 1_000_000
        for (const id of affected) {
          await tx
            .update(pluginInstances)
            .set({ slotOrder: temporarySlot++ })
            .where(eq(pluginInstances.id, id))
        }
        for (const [index, plugin] of source.entries()) {
          await tx
            .update(pluginInstances)
            .set({
              channelId: moving.channelId,
              role: moving.role,
              slotOrder: moving.role === "instrument" ? 0 : index
            })
            .where(eq(pluginInstances.id, plugin.id))
        }
        for (const [index, plugin] of destination.entries()) {
          await tx
            .update(pluginInstances)
            .set({
              channelId: command.channelId,
              role: command.role,
              slotOrder: command.role === "instrument" ? 0 : index
            })
            .where(eq(pluginInstances.id, plugin.id))
        }
      }
      return
    case "replace-plugin":
      await tx.delete(pluginInstances).where(eq(pluginInstances.id, command.pluginId))
      await tx.insert(pluginInstances).values(pluginValue(command.plugin))
      return
    case "create-midi-source":
      await tx.insert(midiSources).values(command.source)
      return
    case "delete-midi-source":
      await tx.delete(midiSources).where(eq(midiSources.id, command.source.id))
      return
    case "create-midi-clip":
      await insertMidiClip(tx, command.clip)
      return
    case "delete-midi-clip":
      await tx.delete(midiClips).where(eq(midiClips.id, command.clipId))
      return
    case "move-midi-clip":
      await tx
        .update(midiClips)
        .set({ trackId: command.trackId, startTick: command.startTick })
        .where(eq(midiClips.id, command.clipId))
      return
    case "update-midi-clip-range": {
      const patch = midiClipRangePatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(midiClips).set(patch).where(eq(midiClips.id, command.clipId))
      }
      return
    }
    case "create-midi-notes":
      if (command.notes.length > 0) {
        await tx.insert(midiNotes).values(
          command.notes.map((note) => ({
            id: note.id,
            clipId: command.clipId,
            startTick: note.startTick,
            durationTicks: note.durationTicks,
            channel: note.channel,
            key: note.key,
            velocity: note.velocity,
            releaseVelocity: note.releaseVelocity
          }))
        )
      }
      return
    case "delete-midi-notes":
      if (command.noteIds.length > 0) {
        await tx
          .delete(midiNotes)
          .where(and(eq(midiNotes.clipId, command.clipId), inArray(midiNotes.id, command.noteIds)))
      }
      return
    case "update-midi-notes":
      for (const update of command.updates) {
        const patch = midiNotePatch(update.patch)
        if (Object.keys(patch).length === 0) continue
        await tx
          .update(midiNotes)
          .set(patch)
          .where(and(eq(midiNotes.clipId, command.clipId), eq(midiNotes.id, update.noteId)))
      }
      return
    case "rebase-midi-clip-content": {
      const [notes, events] = await Promise.all([
        tx
          .select({ id: midiNotes.id, startTick: midiNotes.startTick })
          .from(midiNotes)
          .where(eq(midiNotes.clipId, command.clipId)),
        tx
          .select({ id: midiEvents.id, tick: midiEvents.tick })
          .from(midiEvents)
          .where(eq(midiEvents.clipId, command.clipId))
      ])
      for (const note of notes) {
        await tx
          .update(midiNotes)
          .set({ startTick: note.startTick + command.deltaTicks })
          .where(eq(midiNotes.id, note.id))
      }
      for (const event of events) {
        await tx
          .update(midiEvents)
          .set({ tick: event.tick + command.deltaTicks })
          .where(eq(midiEvents.id, event.id))
      }
      return
    }
    case "replace-tempo-map": {
      const initialTempo = command.tempoMap.tempoEvents[0]
      const initialSignature = command.tempoMap.timeSignatureEvents[0]
      if (
        !initialTempo ||
        initialTempo.tick !== 0 ||
        !initialSignature ||
        initialSignature.tick !== 0
      ) {
        throw new Error("Tempo map requires tick 0 events")
      }
      await tx
        .update(tempoEvents)
        .set({ beatsPerMinute: initialTempo.beatsPerMinute })
        .where(eq(tempoEvents.tick, 0))
      await tx.delete(tempoEvents).where(ne(tempoEvents.tick, 0))
      if (command.tempoMap.tempoEvents.length > 1) {
        await tx.insert(tempoEvents).values(
          command.tempoMap.tempoEvents.slice(1).map((event) => ({
            tick: event.tick,
            beatsPerMinute: event.beatsPerMinute
          }))
        )
      }
      await tx
        .update(timeSignatureEvents)
        .set({
          numerator: initialSignature.numerator,
          denominator: initialSignature.denominator
        })
        .where(eq(timeSignatureEvents.tick, 0))
      await tx.delete(timeSignatureEvents).where(ne(timeSignatureEvents.tick, 0))
      if (command.tempoMap.timeSignatureEvents.length > 1) {
        await tx.insert(timeSignatureEvents).values(
          command.tempoMap.timeSignatureEvents.slice(1).map((event) => ({
            tick: event.tick,
            numerator: event.numerator,
            denominator: event.denominator
          }))
        )
      }
      return
    }
    case "replace-key-signature-map": {
      const initialKey = command.events[0]
      if (!initialKey || initialKey.tick !== 0) {
        throw new Error("Key-signature map requires a tick 0 event")
      }
      await tx
        .update(keySignatureEvents)
        .set({ fifths: initialKey.fifths, mode: initialKey.mode })
        .where(eq(keySignatureEvents.tick, 0))
      await tx.delete(keySignatureEvents).where(ne(keySignatureEvents.tick, 0))
      if (command.events.length > 1) {
        await tx.insert(keySignatureEvents).values(command.events.slice(1))
      }
      return
    }
    case "batch":
      for (const nested of command.commands) {
        await applyProjectCommand(tx, nested, fallbackOutputId)
      }
  }
}

export async function assertProjectCommandAllowed(
  tx: ProjectTransaction,
  command: ProjectCommand
): Promise<void> {
  switch (command.type) {
    case "delete-channel": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(mixerChannels)
        .where(eq(mixerChannels.id, command.channelId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot be deleted")
      }
      return
    }
    case "create-clip":
    case "create-midi-clip": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(mixerChannels)
        .where(eq(mixerChannels.id, command.clip.trackId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot contain clips")
      }
      return
    }
    case "move-clip":
    case "move-midi-clip": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(mixerChannels)
        .where(eq(mixerChannels.id, command.trackId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot contain clips")
      }
      return
    }
    case "create-midi-source":
    case "delete-midi-source":
      if (
        !command.source.id ||
        command.source.name.trim().length === 0 ||
        !command.source.contentHash ||
        !(command.source.rawBytes instanceof Uint8Array)
      ) {
        throw new Error("MIDI source metadata is invalid")
      }
      return
    case "update-midi-clip-range":
    case "create-midi-notes":
    case "delete-midi-notes":
    case "update-midi-notes":
    case "rebase-midi-clip-content": {
      const rows = await tx
        .select({ clipId: midiClips.id, systemRole: mixerChannels.systemRole })
        .from(midiClips)
        .innerJoin(mixerChannels, eq(mixerChannels.id, midiClips.trackId))
        .where(eq(midiClips.id, command.clipId))
        .limit(1)
      if (!rows[0]) throw new Error(`MIDI clip '${command.clipId}' was not found`)
      if (rows[0].systemRole !== null) {
        throw new Error("System channels cannot contain editable MIDI clips")
      }
      if (
        command.type === "rebase-midi-clip-content" &&
        !Number.isSafeInteger(command.deltaTicks)
      ) {
        throw new Error("MIDI content offsets require 1/3840-note integer resolution")
      }
      return
    }
    case "batch":
      for (const nested of command.commands) {
        await assertProjectCommandAllowed(tx, nested)
      }
      return
    default:
      return
  }
}

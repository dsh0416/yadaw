import { eq } from "drizzle-orm"
import type { MixerChannelPatch, MixerSendPatch, ProjectCommand } from "@yadaw/contracts"
import { mixerChannels, mixerSends, tracks } from "../schema"
import type { ProjectTransaction } from "./database-types"

type ChannelCommand = Extract<
  ProjectCommand,
  {
    type:
      | "create-track"
      | "delete-track"
      | "update-track"
      | "create-channel"
      | "delete-channel"
      | "update-channel"
      | "create-send"
      | "delete-send"
      | "update-send"
  }
>

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

export function isChannelTrackRoutingCommand(command: ProjectCommand): command is ChannelCommand {
  return [
    "create-track",
    "delete-track",
    "update-track",
    "create-channel",
    "delete-channel",
    "update-channel",
    "create-send",
    "delete-send",
    "update-send"
  ].includes(command.type)
}

export async function persistChannelTrackRoutingCommand(
  tx: ProjectTransaction,
  command: ChannelCommand,
  fallbackOutputId: string
): Promise<void> {
  switch (command.type) {
    case "create-track":
      await tx.insert(mixerChannels).values(channelValue(command.channel))
      await tx.insert(tracks).values(command.track)
      return
    case "delete-track": {
      const rows = await tx
        .select({ channelId: tracks.channelId })
        .from(tracks)
        .where(eq(tracks.id, command.trackId))
        .limit(1)
      const channelId = rows[0]?.channelId
      if (!channelId) throw new Error(`Project track '${command.trackId}' was not found`)
      await tx
        .update(mixerChannels)
        .set({ outputChannelId: fallbackOutputId, outputBus: null })
        .where(eq(mixerChannels.outputChannelId, channelId))
      await tx.delete(tracks).where(eq(tracks.id, command.trackId))
      await tx.delete(mixerChannels).where(eq(mixerChannels.id, channelId))
      return
    }
    case "update-track":
      if (command.patch.sortOrder !== undefined || command.patch.notes !== undefined) {
        await tx
          .update(tracks)
          .set({ sortOrder: command.patch.sortOrder, notes: command.patch.notes })
          .where(eq(tracks.id, command.trackId))
      }
      return
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
    }
  }
}

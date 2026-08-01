import { and, eq, inArray } from "drizzle-orm"
import type { MidiClipRangePatch, MidiNotePatch, ProjectCommand } from "@yadaw/contracts"
import { midiClips, midiEvents, midiNotes, midiSources } from "../schema"
import type { ProjectTransaction } from "./database-types"

type MidiCommand = Extract<
  ProjectCommand,
  {
    type:
      | "create-midi-source"
      | "delete-midi-source"
      | "create-midi-clip"
      | "delete-midi-clip"
      | "move-midi-clip"
      | "update-midi-clip-range"
      | "create-midi-notes"
      | "delete-midi-notes"
      | "update-midi-notes"
      | "rebase-midi-clip-content"
  }
>

function rangePatch(patch: MidiClipRangePatch): Partial<typeof midiClips.$inferInsert> {
  const result: Partial<typeof midiClips.$inferInsert> = {}
  if (patch.startTick !== undefined) result.startTick = patch.startTick
  if (patch.lengthTicks !== undefined) result.lengthTicks = patch.lengthTicks
  if (patch.sourceOffsetTicks !== undefined) result.sourceOffsetTicks = patch.sourceOffsetTicks
  if (patch.sourceLengthTicks !== undefined) result.sourceLengthTicks = patch.sourceLengthTicks
  return result
}

function notePatch(patch: MidiNotePatch): Partial<typeof midiNotes.$inferInsert> {
  const result: Partial<typeof midiNotes.$inferInsert> = {}
  if (patch.startTick !== undefined) result.startTick = patch.startTick
  if (patch.durationTicks !== undefined) result.durationTicks = patch.durationTicks
  if (patch.channel !== undefined) result.channel = patch.channel
  if (patch.key !== undefined) result.key = patch.key
  if (patch.velocity !== undefined) result.velocity = patch.velocity
  if (patch.releaseVelocity !== undefined) result.releaseVelocity = patch.releaseVelocity
  return result
}

async function insertClip(
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
    sourceOffsetTicks: clip.sourceOffsetTicks,
    sourceLengthTicks: clip.sourceLengthTicks
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

export function isMidiCommand(command: ProjectCommand): command is MidiCommand {
  return [
    "create-midi-source",
    "delete-midi-source",
    "create-midi-clip",
    "delete-midi-clip",
    "move-midi-clip",
    "update-midi-clip-range",
    "create-midi-notes",
    "delete-midi-notes",
    "update-midi-notes",
    "rebase-midi-clip-content"
  ].includes(command.type)
}

export async function persistMidiCommand(
  tx: ProjectTransaction,
  command: MidiCommand
): Promise<void> {
  switch (command.type) {
    case "create-midi-source":
      await tx.insert(midiSources).values(command.source)
      return
    case "delete-midi-source":
      await tx.delete(midiSources).where(eq(midiSources.id, command.source.id))
      return
    case "create-midi-clip":
      await insertClip(tx, command.clip)
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
      const patch = rangePatch(command.patch)
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
        const patch = notePatch(update.patch)
        if (Object.keys(patch).length > 0) {
          await tx
            .update(midiNotes)
            .set(patch)
            .where(and(eq(midiNotes.clipId, command.clipId), eq(midiNotes.id, update.noteId)))
        }
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
    }
  }
}

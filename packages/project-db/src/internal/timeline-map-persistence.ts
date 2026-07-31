import { eq, ne } from "drizzle-orm"
import type { ProjectCommand } from "@yadaw/contracts"
import { keySignatureEvents, tempoEvents, timeSignatureEvents } from "../schema"
import type { ProjectTransaction } from "./database-types"

type TimelineMapCommand = Extract<
  ProjectCommand,
  { type: "replace-tempo-map" | "replace-key-signature-map" }
>

export function isTimelineMapCommand(command: ProjectCommand): command is TimelineMapCommand {
  return command.type === "replace-tempo-map" || command.type === "replace-key-signature-map"
}

export async function persistTimelineMapCommand(
  tx: ProjectTransaction,
  command: TimelineMapCommand
): Promise<void> {
  switch (command.type) {
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
        await tx.insert(tempoEvents).values(command.tempoMap.tempoEvents.slice(1))
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
        await tx.insert(timeSignatureEvents).values(command.tempoMap.timeSignatureEvents.slice(1))
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
    }
  }
}

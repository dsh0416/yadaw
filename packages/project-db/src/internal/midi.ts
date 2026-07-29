import { eq } from "drizzle-orm"
import type { PgliteDatabase } from "drizzle-orm/pglite"
import type { ProjectCommand } from "@yadaw/contracts"
import type { MidiSourceInput } from "../protocol"
import { midiSources } from "../schema"
import * as schema from "../schema"
import { applyProjectCommand, assertProjectCommandAllowed } from "./command-persistence"

type ProjectDb = PgliteDatabase<typeof schema>

export function importMidiSource(
  db: ProjectDb,
  source: MidiSourceInput,
  command: ProjectCommand,
  fallbackOutputId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    await assertProjectCommandAllowed(tx, command)
    await tx.insert(midiSources).values(source)
    await applyProjectCommand(tx, command, fallbackOutputId)
  })
}

export function rollbackMidiSource(
  db: ProjectDb,
  sourceId: string,
  command: ProjectCommand,
  fallbackOutputId: string
): Promise<void> {
  return db.transaction(async (tx) => {
    await assertProjectCommandAllowed(tx, command)
    await applyProjectCommand(tx, command, fallbackOutputId)
    await tx.delete(midiSources).where(eq(midiSources.id, sourceId))
  })
}

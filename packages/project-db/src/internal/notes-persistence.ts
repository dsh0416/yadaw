import { eq } from "drizzle-orm"
import type { ProjectCommand } from "@yadaw/contracts"
import { PROJECT_ID, project } from "../schema"
import type { ProjectTransaction } from "./database-types"

type NotesCommand = Extract<ProjectCommand, { type: "update-project-notes" }>

export function isNotesCommand(command: ProjectCommand): command is NotesCommand {
  return command.type === "update-project-notes"
}

export async function persistNotesCommand(
  tx: ProjectTransaction,
  command: NotesCommand
): Promise<void> {
  await tx.update(project).set({ notes: command.notes }).where(eq(project.id, PROJECT_ID))
}

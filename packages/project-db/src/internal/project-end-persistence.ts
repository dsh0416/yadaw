import { eq } from "drizzle-orm"
import type { ProjectCommand } from "@heron/contracts"
import { PROJECT_ID, project } from "../schema"
import type { ProjectTransaction } from "./database-types"

type ProjectEndCommand = Extract<ProjectCommand, { type: "update-project-end" }>

export function isProjectEndCommand(command: ProjectCommand): command is ProjectEndCommand {
  return command.type === "update-project-end"
}

export async function persistProjectEndCommand(
  tx: ProjectTransaction,
  command: ProjectEndCommand
): Promise<void> {
  await tx
    .update(project)
    .set({ projectEndTick: command.endTick })
    .where(eq(project.id, PROJECT_ID))
}

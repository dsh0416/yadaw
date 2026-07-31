import { eq } from "drizzle-orm"
import type { ProjectCommand } from "@yadaw/contracts"
import { audioClips } from "../schema"
import type { ProjectTransaction } from "./database-types"

type AudioClipCommand = Extract<
  ProjectCommand,
  { type: "create-audio-clip" | "delete-audio-clip" | "move-audio-clip" }
>

export function isAudioClipCommand(command: ProjectCommand): command is AudioClipCommand {
  return (
    command.type === "create-audio-clip" ||
    command.type === "delete-audio-clip" ||
    command.type === "move-audio-clip"
  )
}

export async function persistAudioClipCommand(
  tx: ProjectTransaction,
  command: AudioClipCommand
): Promise<void> {
  switch (command.type) {
    case "create-audio-clip":
      await tx.insert(audioClips).values({
        ...command.clip,
        startFrame: BigInt(command.clip.startFrame),
        sourceOffsetFrames: BigInt(command.clip.sourceOffsetFrames),
        lengthFrames: BigInt(command.clip.lengthFrames)
      })
      return
    case "delete-audio-clip":
      await tx.delete(audioClips).where(eq(audioClips.id, command.clipId))
      return
    case "move-audio-clip":
      await tx
        .update(audioClips)
        .set({ trackId: command.trackId, startFrame: BigInt(command.startFrame) })
        .where(eq(audioClips.id, command.clipId))
  }
}

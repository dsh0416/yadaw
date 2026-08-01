import { eq } from "drizzle-orm"
import type { AudioClipPatch, ProjectCommand } from "@yadaw/contracts"
import { audioClips } from "../schema"
import type { ProjectTransaction } from "./database-types"

type AudioClipCommand = Extract<
  ProjectCommand,
  {
    type: "create-audio-clip" | "delete-audio-clip" | "move-audio-clip" | "update-audio-clip"
  }
>

function clipPatch(patch: AudioClipPatch): Partial<typeof audioClips.$inferInsert> {
  const result: Partial<typeof audioClips.$inferInsert> = {}
  if (patch.startFrame !== undefined) result.startFrame = BigInt(patch.startFrame)
  if (patch.sourceOffsetFrames !== undefined) {
    result.sourceOffsetFrames = BigInt(patch.sourceOffsetFrames)
  }
  if (patch.lengthFrames !== undefined) result.lengthFrames = BigInt(patch.lengthFrames)
  if (patch.fadeInFrames !== undefined) result.fadeInFrames = BigInt(patch.fadeInFrames)
  if (patch.fadeOutFrames !== undefined) result.fadeOutFrames = BigInt(patch.fadeOutFrames)
  return result
}

export function isAudioClipCommand(command: ProjectCommand): command is AudioClipCommand {
  return (
    command.type === "create-audio-clip" ||
    command.type === "delete-audio-clip" ||
    command.type === "move-audio-clip" ||
    command.type === "update-audio-clip"
  )
}

export async function persistAudioClipCommand(
  tx: ProjectTransaction,
  command: AudioClipCommand
): Promise<void> {
  switch (command.type) {
    case "create-audio-clip":
      await tx.insert(audioClips).values({
        id: command.clip.id,
        assetId: command.clip.assetId,
        trackId: command.clip.trackId,
        name: command.clip.name,
        startFrame: BigInt(command.clip.startFrame),
        sourceOffsetFrames: BigInt(command.clip.sourceOffsetFrames),
        lengthFrames: BigInt(command.clip.lengthFrames),
        fadeInFrames: BigInt(command.clip.fadeInFrames),
        fadeOutFrames: BigInt(command.clip.fadeOutFrames)
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
      return
    case "update-audio-clip": {
      const patch = clipPatch(command.patch)
      if (Object.keys(patch).length > 0) {
        await tx.update(audioClips).set(patch).where(eq(audioClips.id, command.clipId))
      }
    }
  }
}

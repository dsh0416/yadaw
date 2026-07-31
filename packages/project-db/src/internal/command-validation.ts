import { eq } from "drizzle-orm"
import type { ProjectCommand } from "@yadaw/contracts"
import { midiClips, mixerChannels, tracks } from "../schema"
import type { ProjectTransaction } from "./database-types"

export async function assertProjectCommandAllowed(
  tx: ProjectTransaction,
  command: ProjectCommand
): Promise<void> {
  switch (command.type) {
    case "delete-track": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(tracks)
        .innerJoin(mixerChannels, eq(mixerChannels.id, tracks.channelId))
        .where(eq(tracks.id, command.trackId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot be deleted")
      }
      return
    }
    case "delete-channel": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole, trackId: tracks.id })
        .from(mixerChannels)
        .leftJoin(tracks, eq(tracks.channelId, mixerChannels.id))
        .where(eq(mixerChannels.id, command.channelId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot be deleted")
      }
      if (rows[0]?.trackId) {
        throw new Error("Track-owned channels must be deleted through delete-track")
      }
      return
    }
    case "create-audio-clip":
    case "create-midi-clip": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(tracks)
        .innerJoin(mixerChannels, eq(mixerChannels.id, tracks.channelId))
        .where(eq(tracks.id, command.clip.trackId))
        .limit(1)
      if (rows[0]?.systemRole !== null && rows[0]?.systemRole !== undefined) {
        throw new Error("System channels cannot contain clips")
      }
      return
    }
    case "move-audio-clip":
    case "move-midi-clip": {
      const rows = await tx
        .select({ systemRole: mixerChannels.systemRole })
        .from(tracks)
        .innerJoin(mixerChannels, eq(mixerChannels.id, tracks.channelId))
        .where(eq(tracks.id, command.trackId))
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
        .innerJoin(tracks, eq(tracks.id, midiClips.trackId))
        .innerJoin(mixerChannels, eq(mixerChannels.id, tracks.channelId))
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
  }
}

import type { ProjectCommand } from "@yadaw/contracts"
import { isAudioClipCommand, persistAudioClipCommand } from "./audio-clip-persistence"
import {
  isChannelTrackRoutingCommand,
  persistChannelTrackRoutingCommand
} from "./channel-track-routing-persistence"
import type { ProjectTransaction } from "./database-types"
import { isMidiCommand, persistMidiCommand } from "./midi-persistence"
import { isNotesCommand, persistNotesCommand } from "./notes-persistence"
import { isPluginCommand, persistPluginCommand } from "./plugin-persistence"
import { isTimelineMapCommand, persistTimelineMapCommand } from "./timeline-map-persistence"

export { assertProjectCommandAllowed } from "./command-validation"

export async function applyProjectCommand(
  tx: ProjectTransaction,
  command: ProjectCommand,
  fallbackOutputId: string
): Promise<void> {
  if (command.type === "batch") {
    for (const nested of command.commands) {
      await applyProjectCommand(tx, nested, fallbackOutputId)
    }
    return
  }
  if (isChannelTrackRoutingCommand(command)) {
    return persistChannelTrackRoutingCommand(tx, command, fallbackOutputId)
  }
  if (isAudioClipCommand(command)) return persistAudioClipCommand(tx, command)
  if (isPluginCommand(command)) return persistPluginCommand(tx, command)
  if (isMidiCommand(command)) return persistMidiCommand(tx, command)
  if (isNotesCommand(command)) return persistNotesCommand(tx, command)
  if (isTimelineMapCommand(command)) return persistTimelineMapCommand(tx, command)

  command satisfies never
}

import type { MidiSyncPreferences, ProjectGraphSnapshot } from "@heron/contracts"
import type { AudioHostGraph } from "./audio-host-wire"

export class AudioHostSessionCoordinator {
  graph: {
    revision: number
    project: ProjectGraphSnapshot
    runtime: AudioHostGraph
  } | null = null
  published: { revision: number; runtime: AudioHostGraph } | null = null
  recovery: Promise<void> | null = null
  reconfiguring = false
  midiPreferences: MidiSyncPreferences = {
    enabled: false,
    sourcePortId: null,
    sourcePortName: null,
    inputOffsetsMs: {}
  }
  midiPreferencesConfigured = false
  midiControlPortIds: string[] = []
  midiControlLearning = false
}

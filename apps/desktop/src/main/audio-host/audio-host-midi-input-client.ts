import type { AudioHostRuntime } from "@heron/dsp-node"
import type { MidiInputSnapshot, MidiSyncPreferences, ShortcutPreferences } from "@heron/contracts"
import type { ControlResponse } from "./wire"

export class AudioHostMidiInputClient {
  private preferences: MidiSyncPreferences = {
    enabled: false,
    sourcePortId: null,
    sourcePortName: null,
    inputOffsetsMs: {}
  }
  private configured = false
  private controlPortIds: string[] = []
  private controlLearning = false

  constructor(
    private readonly request: (command: Record<string, unknown>) => Promise<ControlResponse>,
    private readonly requestImmediately: (
      command: Record<string, unknown>,
      client: AudioHostRuntime
    ) => Promise<ControlResponse>
  ) {}

  async snapshot(): Promise<MidiInputSnapshot> {
    return this.decode(await this.request({ type: "midi-input-snapshot" }))
  }

  async configure(
    preferences: MidiSyncPreferences,
    shortcuts: ShortcutPreferences = { keyboard: {}, midi: {} }
  ): Promise<MidiInputSnapshot> {
    const controlPortIds = [
      ...new Set(
        Object.values(shortcuts.midi)
          .map((binding) => binding?.portId)
          .filter((portId): portId is string => Boolean(portId))
      )
    ]
    const snapshot = this.decode(
      await this.request(this.configureCommand(preferences, controlPortIds, this.controlLearning))
    )
    this.preferences = structuredClone(preferences)
    this.controlPortIds = controlPortIds
    this.configured = true
    return snapshot
  }

  async setControlLearning(enabled: boolean): Promise<void> {
    this.decode(
      await this.request(this.configureCommand(this.preferences, this.controlPortIds, enabled))
    )
    this.controlLearning = enabled
  }

  async restore(client: AudioHostRuntime): Promise<void> {
    if (!this.configured) return
    this.decode(
      await this.requestImmediately(
        this.configureCommand(this.preferences, this.controlPortIds, this.controlLearning),
        client
      )
    )
  }

  private configureCommand(
    preferences: MidiSyncPreferences,
    controlPortIds: readonly string[],
    captureAllControls: boolean
  ): Record<string, unknown> {
    return {
      type: "configure-midi-input",
      preferences: {
        enabled: preferences.enabled,
        source_port_id: preferences.sourcePortId,
        source_port_name: preferences.sourcePortName,
        input_offsets_ms: preferences.inputOffsetsMs,
        control_port_ids: [...controlPortIds],
        capture_all_controls: captureAllControls
      }
    }
  }

  private decode(response: ControlResponse): MidiInputSnapshot {
    const value = response.result.midi_input
    if (response.result.type !== "midi-input-snapshot" || !value) {
      throw new Error(response.result.error?.userMessageKey ?? "errors.audioEngineUnavailable")
    }
    return {
      ports: value.ports,
      sync: {
        state: value.sync.state as MidiInputSnapshot["sync"]["state"],
        sourcePortId: value.sync.source_port_id,
        sourcePortName: value.sync.source_port_name,
        effectiveBpm: value.sync.effective_bpm,
        jitterMicroseconds: value.sync.jitter_microseconds,
        lastClockAgeMs: value.sync.last_clock_age_ms,
        droppedEvents: value.sync.dropped_events,
        ignoredSystemMessages: value.sync.ignored_system_messages,
        error: value.sync.error
      },
      controlEvents: value.control_events.map((event) => ({
        generation: event.generation,
        timestampMicroseconds: event.timestamp_microseconds,
        portId: event.port_id,
        portName: event.port_name,
        channel: event.channel,
        type: event.type,
        number: event.number,
        value: event.value
      })),
      recordingPreview: value.recording_preview
        ? {
            positionTick: value.recording_preview.position_tick,
            takes: value.recording_preview.takes.map((take) => ({
              clipId: take.clip_id,
              trackId: take.track_id,
              notes: take.notes.map((note) => ({
                id: note.id,
                startTick: note.start_tick,
                endTick: note.end_tick,
                channel: note.channel,
                key: note.key,
                velocity: note.velocity,
                active: note.active
              }))
            }))
          }
        : null,
      capturedAt: value.captured_at
    }
  }
}

import { createHash, randomUUID } from "node:crypto"
import type {
  MidiClipState,
  MidiEventKind,
  MidiEventState,
  MidiNoteState,
  PendingMidiTake,
  ProjectCommand,
  ProjectWorkspaceSnapshot,
  RpcRequestMeta
} from "@yadaw/contracts"
import { IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import { recoverMidiJournalTake } from "@yadaw/dsp-node"
import type { ProjectCommandService } from "./project-command-service"

function eventKind(value: string): MidiEventKind {
  switch (value) {
    case "control-change":
    case "pitch-bend":
    case "program-change":
    case "channel-pressure":
    case "poly-pressure":
    case "sysex":
      return value
    default:
      throw new Error(`Unsupported MIDI journal event kind '${value}'`)
  }
}

function encodeTakeBytes(notes: MidiNoteState[], events: MidiEventState[]): Uint8Array {
  const payload = JSON.stringify({
    version: 1,
    notes: notes.map((note) => ({
      startTick: note.startTick,
      durationTicks: note.durationTicks,
      channel: note.channel,
      key: note.key,
      velocity: note.velocity,
      releaseVelocity: note.releaseVelocity
    })),
    events: events.map((event) => ({
      tick: event.tick,
      channel: event.channel,
      kind: event.kind,
      data: Array.from(event.data)
    }))
  })
  return new TextEncoder().encode(payload)
}

export async function commitMidiRecordingTakes(
  commands: ProjectCommandService,
  workspace: ProjectWorkspaceSnapshot,
  operationId: string,
  startTick: number,
  takes: PendingMidiTake[],
  trackNames: ReadonlyMap<string, string>
): Promise<ProjectWorkspaceSnapshot> {
  if (takes.length === 0) return workspace
  let current = workspace
  for (const take of takes) {
    if (current.graph.midiClips.some((clip) => clip.id === take.clipId)) {
      continue
    }
    const recovered = recoverMidiJournalTake(take.journalPath, startTick)
    const notes: MidiNoteState[] = recovered.notes.map((note) => ({
      id: randomUUID(),
      startTick: note.startTick,
      durationTicks: note.durationTicks,
      channel: note.channel,
      key: note.key,
      velocity: note.velocity,
      releaseVelocity: note.releaseVelocity
    }))
    const events: MidiEventState[] = recovered.events.map((event) => ({
      id: randomUUID(),
      tick: event.tick,
      channel: event.channel ?? null,
      kind: eventKind(event.kind),
      data: new Uint8Array(event.data)
    }))
    const rawBytes = encodeTakeBytes(notes, events)
    const contentHash = createHash("sha256").update(rawBytes).digest("hex")
    const trackName = trackNames.get(take.trackId) ?? "Instrument"
    const clip: MidiClipState = {
      id: take.clipId,
      sourceId: take.sourceId,
      trackId: take.trackId,
      name: `Recording ${trackName}`,
      startTick,
      lengthTicks: Math.max(1, recovered.lengthTicks),
      sourceOffsetTicks: 0,
      sourceLengthTicks: Math.max(1, recovered.lengthTicks),
      notes,
      events
    }
    const meta: RpcRequestMeta = {
      protocolVersion: IPC_PROTOCOL_VERSION,
      requestId: randomUUID(),
      target: current.projectGraph,
      expectedRevision: current.revision,
      mutation: {
        operationId: `${operationId}:midi:${take.clipId}`,
        idempotencyKey: `midi-recording:${take.clipId}`
      }
    }
    const batch: ProjectCommand = {
      type: "batch",
      commands: [{ type: "create-midi-clip", clip }]
    }
    const result = await commands.executeMidiImport(
      meta,
      {
        id: take.sourceId,
        name: `Recording ${trackName}.midijournal`,
        contentHash,
        rawBytes
      },
      batch
    )
    current = result.workspace
  }
  return current
}

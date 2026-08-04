import type {
  MidiClipState,
  MidiSourceState,
  ProjectCommand,
  ProjectGraphSnapshot
} from "@heron/contracts"
import { barLengthTicksAtTick } from "../../utils/tempoMap"
import { snapTicks, type PianoRollSnap } from "../../utils/pianoRoll"
import {
  type AudioFadeEdge,
  type ClipTrimEdge,
  planAudioClipFade,
  planAudioClipSplit,
  planAudioClipTrim,
  planMidiClipSplits,
  planMidiClipTrim
} from "../../utils/clipEditing"
import type { ArrangementTimelineTrack } from "./arrangementWorkspaceTypes"

interface ArrangementEditingPorts {
  graph: () => ProjectGraphSnapshot
  tracks: () => readonly ArrangementTimelineTrack[]
  playheadFrame: () => number
  playheadTick: () => number
  snap: () => PianoRollSnap
  selectedAudioClipId: () => string | null
  selectedMidiClipIds: () => readonly string[]
  execute: (command: ProjectCommand) => Promise<boolean>
  clearAudioSelection: () => void
  selectAudioClip: (clipId: string) => void
  clearMidiSelection: () => void
  selectMidiClip: (clipId: string, additive?: boolean) => void
  openMidiClipSet: (clipIds: string[], activeClipId: string) => void
  openPianoRoll: () => void
  midiClipName: (index: number) => string
  createId?: () => string
}

export function useArrangementEditingCommands(ports: ArrangementEditingPorts) {
  const createId = ports.createId ?? (() => crypto.randomUUID())

  function moveAudioClip(clipId: string, trackId: string, startSeconds: number): Promise<boolean> {
    return ports.execute({
      type: "move-audio-clip",
      clipId,
      trackId,
      startFrame: Math.round(startSeconds * ports.graph().sampleRate)
    })
  }

  async function removeAudioClip(clipId: string): Promise<boolean> {
    const committed = await ports.execute({ type: "delete-audio-clip", clipId })
    if (committed && ports.selectedAudioClipId() === clipId) ports.clearAudioSelection()
    return committed
  }

  function trimAudioClip(clipId: string, edge: ClipTrimEdge, frame: number): Promise<boolean> {
    const clip = ports.graph().audioClips.find((candidate) => candidate.id === clipId)
    const command = clip ? planAudioClipTrim(clip, edge, frame) : null
    return command ? ports.execute(command) : Promise.resolve(false)
  }

  function splitAudioClip(clipId: string): Promise<boolean> {
    const clip = ports.graph().audioClips.find((candidate) => candidate.id === clipId)
    const command = clip ? planAudioClipSplit(clip, ports.playheadFrame()) : null
    return command ? ports.execute(command) : Promise.resolve(false)
  }

  function updateAudioFade(clipId: string, edge: AudioFadeEdge, frames: number): Promise<boolean> {
    const clip = ports.graph().audioClips.find((candidate) => candidate.id === clipId)
    const command = clip ? planAudioClipFade(clip, edge, frames) : null
    return command ? ports.execute(command) : Promise.resolve(false)
  }

  function resetAudioFades(clipId: string): Promise<boolean> {
    const clip = ports.graph().audioClips.find((candidate) => candidate.id === clipId)
    if (!clip || (clip.fadeInFrames === 0 && clip.fadeOutFrames === 0)) {
      return Promise.resolve(false)
    }
    return ports.execute({
      type: "update-audio-clip",
      clipId,
      patch: { fadeInFrames: 0, fadeOutFrames: 0 }
    })
  }

  function reorderTrack(index: number, direction: -1 | 1): Promise<boolean> {
    const targetIndex = index + direction
    const source = ports.tracks()[index]
    const target = ports.tracks()[targetIndex]
    if (!source || !target) return Promise.resolve(false)
    return ports.execute({
      type: "batch",
      commands: [
        { type: "update-track", trackId: source.trackId, patch: { sortOrder: target.sortOrder } },
        { type: "update-track", trackId: target.trackId, patch: { sortOrder: source.sortOrder } }
      ]
    })
  }

  async function removeMidiClip(clipId: string): Promise<boolean> {
    const committed = await ports.execute({ type: "delete-midi-clip", clipId })
    if (committed) ports.clearMidiSelection()
    return committed
  }

  function trimMidiClip(
    clipId: string,
    edge: ClipTrimEdge,
    requestedTick: number
  ): Promise<boolean> {
    const clip = ports.graph().midiClips.find((candidate) => candidate.id === clipId)
    const command = clip
      ? planMidiClipTrim(clip, edge, snapTicks(requestedTick, ports.snap()))
      : null
    return command ? ports.execute(command) : Promise.resolve(false)
  }

  function splitMidiClip(clipId: string): Promise<boolean> {
    const selectedIds = ports.selectedMidiClipIds().includes(clipId)
      ? new Set(ports.selectedMidiClipIds())
      : new Set([clipId])
    const command = planMidiClipSplits(
      ports.graph().midiClips.filter((clip) => selectedIds.has(clip.id)),
      ports.playheadTick()
    )
    return command ? ports.execute(command) : Promise.resolve(false)
  }

  function moveMidiClip(clipId: string, trackId: string, startTick: number): Promise<boolean> {
    return ports.execute({ type: "move-midi-clip", clipId, trackId, startTick })
  }

  function selectAudioClip(clipId: string): void {
    ports.clearMidiSelection()
    ports.selectAudioClip(clipId)
  }

  function selectMidiClip(clipId: string, additive: boolean): void {
    ports.clearAudioSelection()
    ports.selectMidiClip(clipId, additive)
  }

  function openMidiClip(clipId: string, selectedClipIds: string[]): void {
    ports.openMidiClipSet(selectedClipIds, clipId)
    ports.openPianoRoll()
  }

  async function createMidiClip(trackId: string, requestedStartTick: number): Promise<boolean> {
    const sourceId = createId()
    const clipId = createId()
    const startTick = snapTicks(requestedStartTick, ports.snap())
    const name = ports.midiClipName(ports.graph().midiClips.length + 1)
    const source: MidiSourceState = {
      id: sourceId,
      name,
      contentHash: `blank:${sourceId}`,
      rawBytes: new Uint8Array()
    }
    const lengthTicks = barLengthTicksAtTick(ports.graph().tempoMap, startTick)
    const clip: MidiClipState = {
      id: clipId,
      sourceId,
      trackId,
      name,
      startTick,
      lengthTicks,
      sourceOffsetTicks: 0,
      sourceLengthTicks: lengthTicks,
      notes: [],
      events: []
    }
    const committed = await ports.execute({
      type: "batch",
      commands: [
        { type: "create-midi-source", source },
        { type: "create-midi-clip", clip }
      ]
    })
    if (!committed) return false
    ports.clearAudioSelection()
    ports.selectMidiClip(clipId)
    ports.openMidiClipSet([clipId], clipId)
    ports.openPianoRoll()
    return true
  }

  return {
    moveAudioClip,
    removeAudioClip,
    trimAudioClip,
    splitAudioClip,
    updateAudioFade,
    resetAudioFades,
    reorderTrack,
    removeMidiClip,
    trimMidiClip,
    splitMidiClip,
    moveMidiClip,
    selectAudioClip,
    selectMidiClip,
    openMidiClip,
    createMidiClip
  }
}

import type { MidiClipState, ProjectCommand } from "@yadaw/contracts"

export type ClipTrimEdge = "start" | "end"

export function previewMidiClipTrim(
  clip: MidiClipState,
  edge: ClipTrimEdge,
  requestedTick: number
): MidiClipState {
  const sourceStartTick = Math.max(0, clip.startTick - clip.sourceOffsetTicks)
  const sourceEndTick = clip.startTick + (clip.sourceLengthTicks - clip.sourceOffsetTicks)
  if (edge === "start") {
    const startTick = Math.max(
      sourceStartTick,
      Math.min(clip.startTick + clip.lengthTicks - 1, Math.round(requestedTick))
    )
    const deltaTicks = startTick - clip.startTick
    return {
      ...clip,
      startTick,
      sourceOffsetTicks: clip.sourceOffsetTicks + deltaTicks,
      lengthTicks: clip.lengthTicks - deltaTicks
    }
  }

  const endTick = Math.max(clip.startTick + 1, Math.min(sourceEndTick, Math.round(requestedTick)))
  return { ...clip, lengthTicks: endTick - clip.startTick }
}

export function planMidiClipTrim(
  clip: MidiClipState,
  edge: ClipTrimEdge,
  requestedTick: number
): ProjectCommand | null {
  const preview = previewMidiClipTrim(clip, edge, requestedTick)
  if (
    preview.startTick === clip.startTick &&
    preview.sourceOffsetTicks === clip.sourceOffsetTicks &&
    preview.lengthTicks === clip.lengthTicks
  ) {
    return null
  }
  return {
    type: "update-midi-clip-range",
    clipId: clip.id,
    patch: {
      startTick: preview.startTick,
      sourceOffsetTicks: preview.sourceOffsetTicks,
      lengthTicks: preview.lengthTicks
    }
  }
}

export function planMidiClipSplits(
  clips: readonly MidiClipState[],
  playheadTick: number,
  createId: () => string = () => crypto.randomUUID()
): ProjectCommand | null {
  const splitTick = Math.round(playheadTick)
  const commands: ProjectCommand[] = []
  for (const clip of clips) {
    const relativeTicks = splitTick - clip.startTick
    if (relativeTicks <= 0 || relativeTicks >= clip.lengthTicks) continue
    commands.push({
      type: "update-midi-clip-range",
      clipId: clip.id,
      patch: { lengthTicks: relativeTicks }
    })
    commands.push({
      type: "create-midi-clip",
      clip: {
        ...clip,
        id: createId(),
        startTick: splitTick,
        sourceOffsetTicks: clip.sourceOffsetTicks + relativeTicks,
        lengthTicks: clip.lengthTicks - relativeTicks,
        notes: clip.notes.map((note) => ({ ...note, id: createId() })),
        events: clip.events.map((event) => ({
          ...event,
          id: createId(),
          data: new Uint8Array(event.data)
        }))
      }
    })
  }
  return commands.length === 0 ? null : { type: "batch", commands }
}

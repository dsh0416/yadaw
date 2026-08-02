import type { AudioClipState, MidiClipState, ProjectCommand } from "@yadaw/contracts"

export type ClipTrimEdge = "start" | "end"
export type AudioFadeEdge = "in" | "out"

export function projectFrameToAssetFrame(
  projectFrame: number,
  projectSampleRate: number,
  assetSampleRate: number,
  rounding: "floor" | "ceil" = "floor"
): number {
  const scaled = projectFrame * (assetSampleRate / projectSampleRate)
  return Math.max(0, rounding === "ceil" ? Math.ceil(scaled) : Math.floor(scaled))
}

export function previewAudioClipTrim(
  clip: AudioClipState,
  edge: ClipTrimEdge,
  requestedFrame: number
): AudioClipState {
  const sourceStartFrame = Math.max(0, clip.startFrame - clip.sourceOffsetFrames)
  const sourceEndFrame = clip.startFrame + (clip.sourceLengthFrames - clip.sourceOffsetFrames)
  if (edge === "start") {
    const startFrame = Math.max(
      sourceStartFrame,
      Math.min(clip.startFrame + clip.lengthFrames - 1, Math.round(requestedFrame))
    )
    const deltaFrames = startFrame - clip.startFrame
    const lengthFrames = clip.lengthFrames - deltaFrames
    const fadeOutFrames = Math.min(clip.fadeOutFrames, lengthFrames)
    return {
      ...clip,
      startFrame,
      sourceOffsetFrames: clip.sourceOffsetFrames + deltaFrames,
      lengthFrames,
      fadeInFrames: Math.min(clip.fadeInFrames, lengthFrames - fadeOutFrames),
      fadeOutFrames
    }
  }

  const endFrame = Math.max(
    clip.startFrame + 1,
    Math.min(sourceEndFrame, Math.round(requestedFrame))
  )
  const lengthFrames = endFrame - clip.startFrame
  const fadeInFrames = Math.min(clip.fadeInFrames, lengthFrames)
  return {
    ...clip,
    lengthFrames,
    fadeInFrames,
    fadeOutFrames: Math.min(clip.fadeOutFrames, lengthFrames - fadeInFrames)
  }
}

export function planAudioClipTrim(
  clip: AudioClipState,
  edge: ClipTrimEdge,
  requestedFrame: number
): ProjectCommand | null {
  const preview = previewAudioClipTrim(clip, edge, requestedFrame)
  const patch = {
    startFrame: preview.startFrame,
    sourceOffsetFrames: preview.sourceOffsetFrames,
    lengthFrames: preview.lengthFrames,
    fadeInFrames: preview.fadeInFrames,
    fadeOutFrames: preview.fadeOutFrames
  }
  if (Object.entries(patch).every(([key, value]) => clip[key as keyof typeof patch] === value)) {
    return null
  }
  return { type: "update-audio-clip", clipId: clip.id, patch }
}

export function previewAudioClipFade(
  clip: AudioClipState,
  edge: AudioFadeEdge,
  requestedFrames: number
): AudioClipState {
  const fadeFrames = Math.max(0, Math.round(requestedFrames))
  return edge === "in"
    ? { ...clip, fadeInFrames: Math.min(fadeFrames, clip.lengthFrames - clip.fadeOutFrames) }
    : { ...clip, fadeOutFrames: Math.min(fadeFrames, clip.lengthFrames - clip.fadeInFrames) }
}

export function planAudioClipFade(
  clip: AudioClipState,
  edge: AudioFadeEdge,
  requestedFrames: number
): ProjectCommand | null {
  const preview = previewAudioClipFade(clip, edge, requestedFrames)
  const key = edge === "in" ? "fadeInFrames" : "fadeOutFrames"
  return preview[key] === clip[key]
    ? null
    : { type: "update-audio-clip", clipId: clip.id, patch: { [key]: preview[key] } }
}

export function planAudioClipSplit(
  clip: AudioClipState,
  playheadFrame: number,
  createId: () => string = () => crypto.randomUUID()
): ProjectCommand | null {
  const splitFrame = Math.round(playheadFrame)
  const leftLengthFrames = splitFrame - clip.startFrame
  if (leftLengthFrames <= 0 || leftLengthFrames >= clip.lengthFrames) return null
  const rightLengthFrames = clip.lengthFrames - leftLengthFrames
  return {
    type: "batch",
    commands: [
      {
        type: "update-audio-clip",
        clipId: clip.id,
        patch: {
          lengthFrames: leftLengthFrames,
          fadeInFrames: Math.min(clip.fadeInFrames, leftLengthFrames),
          fadeOutFrames: 0
        }
      },
      {
        type: "create-audio-clip",
        clip: {
          ...clip,
          id: createId(),
          startFrame: splitFrame,
          sourceOffsetFrames: clip.sourceOffsetFrames + leftLengthFrames,
          lengthFrames: rightLengthFrames,
          fadeInFrames: 0,
          fadeOutFrames: Math.min(clip.fadeOutFrames, rightLengthFrames)
        }
      }
    ]
  }
}

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

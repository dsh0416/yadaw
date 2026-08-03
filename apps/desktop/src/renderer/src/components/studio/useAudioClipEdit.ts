import { computed, shallowRef } from "vue"
import type { AudioClipState, TempoMapSnapshot } from "@heron/contracts"
import type { MaybeRefOrGetter } from "vue"
import { toValue } from "vue"
import {
  previewAudioClipFade,
  previewAudioClipTrim,
  type AudioFadeEdge,
  type ClipTrimEdge
} from "../../utils/clipEditing"
import { timelineXToSeconds } from "../../utils/timelineCoordinates"

interface AudioClipEditOptions {
  clip: MaybeRefOrGetter<AudioClipState>
  tempoMap: MaybeRefOrGetter<TempoMapSnapshot>
  pixelsPerQuarter: MaybeRefOrGetter<number>
  projectSampleRate: MaybeRefOrGetter<number>
  commitTrim: (edge: ClipTrimEdge, frame: number) => void
  commitFade: (edge: AudioFadeEdge, frames: number) => void
}

type Gesture =
  | { kind: "trim"; edge: ClipTrimEdge; pointerId: number; timelineLeft: number }
  | { kind: "fade"; edge: AudioFadeEdge; pointerId: number; timelineLeft: number }

export function useAudioClipEdit(options: AudioClipEditOptions) {
  const gesture = shallowRef<Gesture | null>(null)
  const preview = shallowRef<AudioClipState | null>(null)
  const active = computed(() => gesture.value !== null)

  function frameAtPointer(event: PointerEvent, timelineLeft: number): number {
    const seconds = timelineXToSeconds(
      toValue(options.tempoMap),
      Math.max(0, event.clientX - timelineLeft),
      toValue(options.pixelsPerQuarter)
    )
    return Math.round(seconds * toValue(options.projectSampleRate))
  }

  function startTrim(event: PointerEvent, edge: ClipTrimEdge): void {
    const clipElement = (event.currentTarget as HTMLElement).closest<HTMLElement>(".audio-clip")
    const lane = clipElement?.parentElement
    if (!clipElement || !lane) return
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    gesture.value = {
      kind: "trim",
      edge,
      pointerId: event.pointerId,
      timelineLeft: lane.getBoundingClientRect().left
    }
    preview.value = toValue(options.clip)
  }

  function startFade(event: PointerEvent, edge: AudioFadeEdge): void {
    const clipElement = (event.currentTarget as HTMLElement).closest<HTMLElement>(".audio-clip")
    const lane = clipElement?.parentElement
    if (!clipElement || !lane) return
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    gesture.value = {
      kind: "fade",
      edge,
      pointerId: event.pointerId,
      timelineLeft: lane.getBoundingClientRect().left
    }
    preview.value = toValue(options.clip)
  }

  function update(event: PointerEvent): void {
    const current = gesture.value
    if (!current || event.pointerId !== current.pointerId) return
    const clip = toValue(options.clip)
    const pointerFrame = frameAtPointer(event, current.timelineLeft)
    preview.value =
      current.kind === "trim"
        ? previewAudioClipTrim(clip, current.edge, pointerFrame)
        : previewAudioClipFade(
            clip,
            current.edge,
            current.edge === "in"
              ? pointerFrame - clip.startFrame
              : clip.startFrame + clip.lengthFrames - pointerFrame
          )
  }

  function finish(event: PointerEvent): void {
    const current = gesture.value
    if (!current || event.pointerId !== current.pointerId) return
    const value = preview.value
    gesture.value = null
    preview.value = null
    if (!value) return
    if (current.kind === "trim") {
      const frame =
        current.edge === "start" ? value.startFrame : value.startFrame + value.lengthFrames
      options.commitTrim(current.edge, frame)
    } else {
      options.commitFade(
        current.edge,
        current.edge === "in" ? value.fadeInFrames : value.fadeOutFrames
      )
    }
  }

  function cancel(): void {
    gesture.value = null
    preview.value = null
  }

  return { active, preview, startTrim, startFade, update, finish, cancel }
}

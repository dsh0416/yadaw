import { readonly, shallowRef } from "vue"
import type { MidiClipState } from "@heron/contracts"
import type { PianoRollSnap } from "../../utils/pianoRoll"
import { snapTicks } from "../../utils/pianoRoll"
import { type ClipTrimEdge, previewMidiClipTrim } from "../../utils/clipEditing"

interface UseMidiClipTrimOptions {
  clip: () => MidiClipState
  pixelsPerQuarter: () => number
  ticksPerQuarter: () => number
  snap: () => PianoRollSnap
  commit: (edge: ClipTrimEdge, tick: number) => void
}

interface ActiveTrim {
  edge: ClipTrimEdge
  pointerId: number
  pointerStartX: number
  edgeStartTick: number
}

export function useMidiClipTrim(options: UseMidiClipTrimOptions) {
  const preview = shallowRef<MidiClipState | null>(null)
  const active = shallowRef<ActiveTrim | null>(null)

  function requestedTick(event: PointerEvent, trim: ActiveTrim): number {
    const ticksPerQuarter = Math.max(1, options.ticksPerQuarter())
    const pixelsPerTick = options.pixelsPerQuarter() / ticksPerQuarter
    const rawTick =
      trim.edgeStartTick +
      (event.clientX - trim.pointerStartX) / Math.max(Number.EPSILON, pixelsPerTick)
    return snapTicks(rawTick, options.snap())
  }

  function start(event: PointerEvent, edge: ClipTrimEdge): void {
    const clip = options.clip()
    active.value = {
      edge,
      pointerId: event.pointerId,
      pointerStartX: event.clientX,
      edgeStartTick: edge === "start" ? clip.startTick : clip.startTick + clip.lengthTicks
    }
    preview.value = clip
    ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  }

  function update(event: PointerEvent): void {
    const trim = active.value
    if (!trim || event.pointerId !== trim.pointerId) return
    preview.value = previewMidiClipTrim(options.clip(), trim.edge, requestedTick(event, trim))
  }

  function finish(event: PointerEvent): void {
    const trim = active.value
    if (!trim || event.pointerId !== trim.pointerId) return
    update(event)
    const value = preview.value
    active.value = null
    preview.value = null
    if (!value) return
    options.commit(
      trim.edge,
      trim.edge === "start" ? value.startTick : value.startTick + value.lengthTicks
    )
  }

  function cancel(): void {
    active.value = null
    preview.value = null
  }

  return {
    active: readonly(active),
    preview: readonly(preview),
    start,
    update,
    finish,
    cancel
  }
}

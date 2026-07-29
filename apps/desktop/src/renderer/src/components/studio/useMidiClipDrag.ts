import { computed, shallowRef, type Ref, type ShallowRef } from "vue"
import type { MidiClipState, TempoMapSnapshot } from "@yadaw/contracts"
import type { PianoRollSnap } from "../../utils/pianoRoll"
import { snapTicks } from "../../utils/pianoRoll"
import { findNearestTrackId } from "../../utils/clipDrag"
import { timelineXToTick } from "../../utils/timelineCoordinates"

interface MidiClipDragOptions {
  clips: Ref<MidiClipState[]>
  content: Readonly<ShallowRef<HTMLElement | null>>
  tempoMap: () => TempoMapSnapshot
  pixelsPerQuarter: Ref<number>
  snap: Ref<PianoRollSnap>
  moveClip: (clipId: string, trackId: string, startTick: number) => void
}

export function useMidiClipDrag(options: MidiClipDragOptions) {
  const midiClipDrag = shallowRef<{
    clipId: string
    offsetPixels: number
    trackId: string
    startTick: number
  } | null>(null)

  const midiDragPreview = computed<MidiClipState | null>(() => {
    const drag = midiClipDrag.value
    if (!drag) return null
    const clip = options.clips.value.find((candidate) => candidate.id === drag.clipId)
    return clip ? { ...clip, trackId: drag.trackId, startTick: drag.startTick } : null
  })

  function handleMidiClipDragStart(clipId: string, offsetPixels: number): void {
    const clip = options.clips.value.find((candidate) => candidate.id === clipId)
    if (!clip) return
    midiClipDrag.value = {
      clipId,
      offsetPixels,
      trackId: clip.trackId,
      startTick: clip.startTick
    }
  }

  function updateMidiClipDrag(event: DragEvent): void {
    const drag = midiClipDrag.value
    const contentElement = options.content.value
    if (!drag || !contentElement) return
    const lanes = Array.from(
      contentElement.querySelectorAll<HTMLElement>("[data-track-id][data-track-kind='instrument']")
    ).map((lane) => {
      const bounds = lane.getBoundingClientRect()
      return { trackId: lane.dataset.trackId!, top: bounds.top, bottom: bounds.bottom }
    })
    const trackId = findNearestTrackId(lanes, event.clientY)
    if (!trackId) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const contentLeft = contentElement.getBoundingClientRect().left
    const rawTick = timelineXToTick(
      options.tempoMap(),
      Math.max(0, event.clientX - contentLeft - drag.offsetPixels),
      options.pixelsPerQuarter.value
    )
    midiClipDrag.value = {
      ...drag,
      trackId,
      startTick: snapTicks(rawTick, options.snap.value)
    }
  }

  function handleMidiClipDrop(event: DragEvent): void {
    if (!midiClipDrag.value) return
    updateMidiClipDrag(event)
    const drag = midiClipDrag.value
    if (!drag) return
    options.moveClip(drag.clipId, drag.trackId, drag.startTick)
    midiClipDrag.value = null
  }

  function handleMidiClipDragEnd(): void {
    midiClipDrag.value = null
  }

  return {
    midiClipDrag,
    midiDragPreview,
    handleMidiClipDragStart,
    updateMidiClipDrag,
    handleMidiClipDrop,
    handleMidiClipDragEnd
  }
}

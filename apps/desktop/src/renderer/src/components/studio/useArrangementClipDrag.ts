import { computed, shallowRef, useTemplateRef, type Ref } from "vue"
import type { TempoMapSnapshot } from "@yadaw/contracts"
import type { TimelineClip } from "../../stores/transport"
import { clipStartSecondsFromPointer, findNearestTrackId } from "../../utils/clipDrag"

interface ArrangementClipDragOptions {
  clips: Ref<TimelineClip[]>
  tempoMap: () => TempoMapSnapshot
  pixelsPerQuarter: Ref<number>
  moveClip: (clipId: string, trackId: string, startSeconds: number) => void
}

export function useArrangementClipDrag(options: ArrangementClipDragOptions) {
  const content = useTemplateRef<HTMLElement>("content")
  const clipDrag = shallowRef<{
    clipId: string
    offsetPixels: number
    trackId: string
    startSeconds: number
  } | null>(null)

  const dragPreview = computed<TimelineClip | null>(() => {
    const drag = clipDrag.value
    if (!drag) return null
    const clip = options.clips.value.find((candidate) => candidate.id === drag.clipId)
    if (!clip) return null
    return {
      ...clip,
      trackId: drag.trackId,
      startSeconds: drag.startSeconds,
      endSeconds: drag.startSeconds + clip.durationSeconds
    }
  })

  function handleClipDragStart(clipId: string, offsetPixels: number): void {
    const clip = options.clips.value.find((candidate) => candidate.id === clipId)
    if (!clip) return
    clipDrag.value = {
      clipId,
      offsetPixels,
      trackId: clip.trackId,
      startSeconds: clip.startSeconds
    }
  }

  function updateClipDrag(event: DragEvent): void {
    const drag = clipDrag.value
    const contentElement = content.value
    if (!drag || !contentElement) return
    const lanes = Array.from(
      contentElement.querySelectorAll<HTMLElement>("[data-track-id][data-track-kind='audio']")
    ).map((lane) => {
      const bounds = lane.getBoundingClientRect()
      return { trackId: lane.dataset.trackId!, top: bounds.top, bottom: bounds.bottom }
    })
    const trackId = findNearestTrackId(lanes, event.clientY)
    if (!trackId) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const startSeconds = clipStartSecondsFromPointer(
      event.clientX,
      contentElement.getBoundingClientRect().left,
      options.tempoMap(),
      options.pixelsPerQuarter.value,
      drag.offsetPixels
    )
    clipDrag.value = { ...drag, trackId, startSeconds }
  }

  function handleClipDrop(event: DragEvent): void {
    if (!clipDrag.value) return
    updateClipDrag(event)
    const drag = clipDrag.value
    if (!drag) return
    options.moveClip(drag.clipId, drag.trackId, drag.startSeconds)
    clipDrag.value = null
  }

  function handleClipDragEnd(): void {
    clipDrag.value = null
  }

  return {
    content,
    clipDrag,
    dragPreview,
    handleClipDragStart,
    updateClipDrag,
    handleClipDrop,
    handleClipDragEnd
  }
}

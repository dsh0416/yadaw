import {
  computed,
  nextTick,
  shallowRef,
  toValue,
  useTemplateRef,
  watch,
  type MaybeRefOrGetter,
  type Ref
} from "vue"
import { useResizeObserver } from "@vueuse/core"
import type { TempoMapSnapshot } from "@heron/contracts"
import { secondsToTimelineX, timelineXToSeconds } from "../../utils/timelineCoordinates"

interface ArrangementViewportOptions {
  tempoMap: () => TempoMapSnapshot
  pixelsPerQuarter: Ref<number>
  visibleDuration: MaybeRefOrGetter<number>
  zoomTime: (direction: -1 | 1) => void
  zoomTrack: (direction: -1 | 1) => void
  zoomAmplitude: (direction: -1 | 1) => void
}

export function useArrangementViewport(options: ArrangementViewportOptions) {
  const rail = useTemplateRef<HTMLElement>("rail")
  const viewport = useTemplateRef<HTMLElement>("viewport")
  const viewportWidth = shallowRef(1)
  const scrollLeft = shallowRef(0)
  let timeZoomAnchor: { seconds: number; viewportX: number } | null = null

  const contentWidth = computed(() =>
    Math.max(
      viewportWidth.value,
      secondsToTimelineX(
        options.tempoMap(),
        toValue(options.visibleDuration),
        options.pixelsPerQuarter.value
      )
    )
  )
  const viewportStartSeconds = computed(() =>
    timelineXToSeconds(options.tempoMap(), scrollLeft.value, options.pixelsPerQuarter.value)
  )
  const viewportEndSeconds = computed(() =>
    timelineXToSeconds(
      options.tempoMap(),
      scrollLeft.value + viewportWidth.value,
      options.pixelsPerQuarter.value
    )
  )

  function timelineViewportWidth(element: HTMLElement): number {
    return Math.max(1, element.clientWidth - (rail.value?.offsetWidth ?? 0))
  }

  function updateViewportWidth(): void {
    const element = viewport.value
    if (!element) return
    viewportWidth.value = timelineViewportWidth(element)
  }

  function handleScroll(): void {
    const element = viewport.value
    scrollLeft.value = element?.scrollLeft ?? 0
  }

  function handleWheel(event: WheelEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.altKey) {
      options.zoomAmplitude(event.deltaY < 0 ? 1 : -1)
    } else if (event.ctrlKey || event.metaKey) {
      const element = viewport.value
      if (element) {
        const bounds = element.getBoundingClientRect()
        const width = timelineViewportWidth(element)
        const viewportX = Math.max(
          0,
          Math.min(width, event.clientX - bounds.left - (rail.value?.offsetWidth ?? 0))
        )
        timeZoomAnchor = {
          seconds: timelineXToSeconds(
            options.tempoMap(),
            element.scrollLeft + viewportX,
            options.pixelsPerQuarter.value
          ),
          viewportX
        }
      }
      options.zoomTime(event.deltaY < 0 ? 1 : -1)
    } else if (event.altKey) {
      options.zoomTrack(event.deltaY < 0 ? 1 : -1)
    } else if (event.shiftKey && viewport.value) {
      viewport.value.scrollLeft += event.deltaY
    } else {
      return
    }
    event.preventDefault()
  }

  useResizeObserver(viewport, updateViewportWidth)
  useResizeObserver(rail, updateViewportWidth)
  watch(options.pixelsPerQuarter, (value, previous) => {
    const element = viewport.value
    if (!element || !previous) return
    const width = timelineViewportWidth(element)
    const anchor = timeZoomAnchor ?? {
      seconds: timelineXToSeconds(options.tempoMap(), element.scrollLeft + width / 2, previous),
      viewportX: width / 2
    }
    timeZoomAnchor = null
    void nextTick(() => {
      element.scrollLeft = Math.max(
        0,
        secondsToTimelineX(options.tempoMap(), anchor.seconds, value) - anchor.viewportX
      )
      scrollLeft.value = element.scrollLeft
    })
  })

  return {
    rail,
    viewport,
    contentWidth,
    viewportStartSeconds,
    viewportEndSeconds,
    handleScroll,
    handleWheel
  }
}

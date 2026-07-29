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
import type { TempoMapSnapshot } from "@yadaw/contracts"
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

  function syncRailScroll(element: HTMLElement): void {
    const railElement = rail.value
    if (!railElement) return
    railElement.style.paddingBottom = `${Math.max(0, element.offsetHeight - element.clientHeight)}px`
    railElement.scrollTop = element.scrollTop
  }

  function handleScroll(): void {
    const element = viewport.value
    scrollLeft.value = element?.scrollLeft ?? 0
    if (element) syncRailScroll(element)
  }

  function handleWheel(event: WheelEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.altKey) {
      options.zoomAmplitude(event.deltaY < 0 ? 1 : -1)
    } else if (event.ctrlKey || event.metaKey) {
      const element = viewport.value
      if (element) {
        const bounds = element.getBoundingClientRect()
        const viewportX = Math.max(0, Math.min(element.clientWidth, event.clientX - bounds.left))
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

  function handleRailWheel(event: WheelEvent): void {
    const element = viewport.value
    if (!element) return
    if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
      handleWheel(event)
      return
    }
    element.scrollTop += event.deltaY
    element.scrollLeft += event.deltaX
    syncRailScroll(element)
    event.preventDefault()
  }

  useResizeObserver(viewport, (entries) => {
    viewportWidth.value = Math.max(1, entries[0]?.contentRect.width ?? 1)
    if (viewport.value) syncRailScroll(viewport.value)
  })
  watch(options.pixelsPerQuarter, (value, previous) => {
    const element = viewport.value
    if (!element || !previous) return
    const anchor = timeZoomAnchor ?? {
      seconds: timelineXToSeconds(
        options.tempoMap(),
        element.scrollLeft + element.clientWidth / 2,
        previous
      ),
      viewportX: element.clientWidth / 2
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
    handleWheel,
    handleRailWheel
  }
}

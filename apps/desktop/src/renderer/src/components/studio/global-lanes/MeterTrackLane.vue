<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { TempoMapSnapshot, TimeSignatureEventState } from "@heron/contracts"
import {
  barTicksThroughTick,
  beatTicksThroughTick,
  timeSignatureAtTick
} from "../../../utils/tempoMap"
import GlobalMarkerLane, { type GlobalMarkerLanePoint } from "./GlobalMarkerLane.vue"

const props = defineProps<{
  tempoMap: TempoMapSnapshot
  selectedTick: number | null
  contentWidth: number
  pixelsPerQuarter: number
  height: number
}>()

const emit = defineEmits<{
  replace: [tempoMap: TempoMapSnapshot]
  select: [tick: number | null]
}>()

const { t } = useI18n()

const points = computed<GlobalMarkerLanePoint[]>(() =>
  props.tempoMap.timeSignatureEvents.map((event) => ({
    id: String(event.tick),
    position: event.tick / props.tempoMap.ticksPerQuarter,
    label: `${event.numerator}/${event.denominator}`,
    lockTime: event.tick === 0,
    lockRemoval: event.tick === 0
  }))
)
const selectedId = computed(() => (props.selectedTick === null ? null : String(props.selectedTick)))
const verticalGuides = computed(() => {
  const maximumTick = (props.contentWidth / props.pixelsPerQuarter) * props.tempoMap.ticksPerQuarter
  return barTicksThroughTick(props.tempoMap, maximumTick).map(
    (tick) => (tick / props.tempoMap.ticksPerQuarter) * props.pixelsPerQuarter
  )
})
const beatGuides = computed(() => {
  const maximumTick = (props.contentWidth / props.pixelsPerQuarter) * props.tempoMap.ticksPerQuarter
  return beatTicksThroughTick(props.tempoMap, maximumTick).map(
    (tick) => (tick / props.tempoMap.ticksPerQuarter) * props.pixelsPerQuarter
  )
})

function replaceEvents(events: TimeSignatureEventState[], selectedTick: number | null): void {
  const byTick = new Map<number, TimeSignatureEventState>()
  for (const event of events) {
    const tick = Math.max(0, Math.round(event.tick))
    byTick.set(tick, {
      tick,
      numerator: Math.min(32, Math.max(1, Math.round(event.numerator))),
      denominator: [1, 2, 4, 8, 16, 32].includes(event.denominator) ? event.denominator : 4
    })
  }
  if (!byTick.has(0)) byTick.set(0, { tick: 0, numerator: 4, denominator: 4 })
  emit("replace", {
    ...props.tempoMap,
    timeSignatureEvents: [...byTick.values()].sort((left, right) => left.tick - right.tick)
  })
  emit("select", selectedTick)
}

function snapTickToBar(tempoMap: TempoMapSnapshot, tick: number): number {
  let signatureIndex = 0
  for (let index = 1; index < tempoMap.timeSignatureEvents.length; index += 1) {
    if (tempoMap.timeSignatureEvents[index]!.tick > tick) break
    signatureIndex = index
  }
  const signature = tempoMap.timeSignatureEvents[signatureIndex] ?? {
    tick: 0,
    numerator: 4,
    denominator: 4
  }
  const ticksPerBar = (signature.numerator * tempoMap.ticksPerQuarter * 4) / signature.denominator
  const previousBar =
    signature.tick + Math.floor(Math.max(0, tick - signature.tick) / ticksPerBar) * ticksPerBar
  const nextSignatureTick =
    tempoMap.timeSignatureEvents[signatureIndex + 1]?.tick ?? Number.POSITIVE_INFINITY
  const nextBar = Math.min(previousBar + ticksPerBar, nextSignatureTick)
  return Math.abs(tick - previousBar) <= Math.abs(nextBar - tick) ? previousBar : nextBar
}

function createPoint(position: number): void {
  const pointerTick = Math.max(0, Math.round(position * props.tempoMap.ticksPerQuarter))
  const tick = snapTickToBar(props.tempoMap, pointerTick)
  const active = timeSignatureAtTick(props.tempoMap, tick)
  replaceEvents([...props.tempoMap.timeSignatureEvents, { ...active, tick }], tick)
}

function updatePoint(id: string, position: number): void {
  const previousTick = Number(id)
  const pointerTick = Math.max(0, Math.round(position * props.tempoMap.ticksPerQuarter))
  const mapWithoutMovedEvent: TempoMapSnapshot = {
    ...props.tempoMap,
    timeSignatureEvents: props.tempoMap.timeSignatureEvents.filter(
      (candidate) => candidate.tick === 0 || candidate.tick !== previousTick
    )
  }
  const nextTick = previousTick === 0 ? 0 : snapTickToBar(mapWithoutMovedEvent, pointerTick)
  const event = props.tempoMap.timeSignatureEvents.find(
    (candidate) => candidate.tick === previousTick
  )
  if (!event) return
  replaceEvents(
    props.tempoMap.timeSignatureEvents
      .filter((candidate) => candidate.tick !== previousTick)
      .concat({ ...event, tick: nextTick }),
    nextTick
  )
}

function removePoint(id: string): void {
  const tick = Number(id)
  if (tick === 0) return
  replaceEvents(
    props.tempoMap.timeSignatureEvents.filter((event) => event.tick !== tick),
    0
  )
}
</script>

<template>
  <GlobalMarkerLane
    :points="points"
    :selected-id="selectedId"
    :content-width="contentWidth"
    :pixels-per-unit="pixelsPerQuarter"
    :height="height"
    :beat-guides="beatGuides"
    :vertical-guides="verticalGuides"
    color="var(--ui-domain-color-f2a65a)"
    :value-label="t('studio.lanes.meter')"
    :position-label="t('studio.lanes.positionLabel')"
    @create="createPoint"
    @update="updatePoint"
    @remove="removePoint"
    @select="emit('select', $event === null ? null : Number($event))"
  />
</template>

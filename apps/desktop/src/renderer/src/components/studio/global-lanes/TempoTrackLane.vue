<script setup lang="ts">
import { computed } from "vue"
import type { TempoEventState, TempoMapSnapshot } from "@yadaw/contracts"
import { barTicksThroughTick } from "../../../utils/tempoMap"
import GlobalValueLane, { type GlobalLanePoint } from "./GlobalValueLane.vue"

const MINIMUM_TEMPO = 20
const MAXIMUM_TEMPO = 300

const props = defineProps<{
  tempoMap: TempoMapSnapshot
  selectedTick: number | null
  contentWidth: number
  pixelsPerQuarter: number
  height: number
  expanded: boolean
}>()

const emit = defineEmits<{
  replace: [tempoMap: TempoMapSnapshot]
  select: [tick: number | null]
}>()

const tempoRange = computed(() => {
  const values = props.tempoMap.tempoEvents.map((event) => event.beatsPerMinute)
  const minimumValue = Math.min(...values, 120)
  const maximumValue = Math.max(...values, 120)
  const center = (minimumValue + maximumValue) / 2
  const span = Math.max(80, maximumValue - minimumValue + 40)
  let minimum = Math.max(MINIMUM_TEMPO, Math.floor((center - span / 2) / 10) * 10)
  let maximum = Math.min(MAXIMUM_TEMPO, Math.ceil((center + span / 2) / 10) * 10)
  if (maximum - minimum < 80) {
    if (minimum === MINIMUM_TEMPO) maximum = Math.min(MAXIMUM_TEMPO, minimum + 80)
    else minimum = Math.max(MINIMUM_TEMPO, maximum - 80)
  }
  return { minimum, maximum }
})
const guides = computed(() => {
  const { minimum, maximum } = tempoRange.value
  return [maximum, (minimum + maximum) / 2, minimum]
})
const points = computed<GlobalLanePoint[]>(() =>
  props.tempoMap.tempoEvents.map((event) => ({
    id: String(event.tick),
    position: event.tick / props.tempoMap.ticksPerQuarter,
    value: event.beatsPerMinute,
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

function normalizeTempo(value: number): number {
  return Math.round(Math.min(MAXIMUM_TEMPO, Math.max(MINIMUM_TEMPO, value)) * 100) / 100
}

function replaceEvents(events: TempoEventState[], selectedTick: number | null): void {
  const byTick = new Map<number, TempoEventState>()
  for (const event of events) {
    const tick = Math.max(0, Math.round(event.tick))
    byTick.set(tick, { tick, beatsPerMinute: normalizeTempo(event.beatsPerMinute) })
  }
  if (!byTick.has(0)) {
    byTick.set(0, { tick: 0, beatsPerMinute: 120 })
  }
  emit("replace", {
    ...props.tempoMap,
    tempoEvents: [...byTick.values()].sort((left, right) => left.tick - right.tick)
  })
  emit("select", selectedTick)
}

function createPoint(position: number, value: number): void {
  const tick = Math.max(0, Math.round(position * props.tempoMap.ticksPerQuarter))
  replaceEvents([...props.tempoMap.tempoEvents, { tick, beatsPerMinute: value }], tick)
}

function updatePoint(id: string, position: number, value: number): void {
  const previousTick = Number(id)
  const nextTick =
    previousTick === 0 ? 0 : Math.max(0, Math.round(position * props.tempoMap.ticksPerQuarter))
  replaceEvents(
    props.tempoMap.tempoEvents
      .filter((event) => event.tick !== previousTick)
      .concat({ tick: nextTick, beatsPerMinute: value }),
    nextTick
  )
}

function removePoint(id: string): void {
  const tick = Number(id)
  if (tick === 0) return
  replaceEvents(
    props.tempoMap.tempoEvents.filter((event) => event.tick !== tick),
    0
  )
}
</script>

<template>
  <GlobalValueLane
    :points="points"
    :selected-id="selectedId"
    :content-width="contentWidth"
    :pixels-per-unit="pixelsPerQuarter"
    :height="height"
    :minimum="tempoRange.minimum"
    :maximum="tempoRange.maximum"
    :guides="guides"
    :vertical-guides="verticalGuides"
    color="var(--ui-domain-color-65a8ff)"
    :expanded="expanded"
    value-label="Tempo"
    position-label="beats"
    @create="createPoint"
    @update="updatePoint"
    @remove="removePoint"
    @select="emit('select', $event === null ? null : Number($event))"
  />
</template>

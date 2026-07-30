<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { KeySignatureEventState, TempoMapSnapshot } from "@yadaw/contracts"
import { keySignatureLabel } from "../../../utils/keySignatures"
import { barTicksThroughTick, beatTicksThroughTick } from "../../../utils/tempoMap"
import GlobalMarkerLane, { type GlobalMarkerLanePoint } from "./GlobalMarkerLane.vue"

const props = defineProps<{
  events: KeySignatureEventState[]
  tempoMap: TempoMapSnapshot
  selectedTick: number | null
  contentWidth: number
  pixelsPerQuarter: number
  height: number
  expanded: boolean
}>()

const emit = defineEmits<{
  replace: [events: KeySignatureEventState[]]
  select: [tick: number | null]
}>()

const { t } = useI18n()

const points = computed<GlobalMarkerLanePoint[]>(() =>
  props.events.map((event) => ({
    id: String(event.tick),
    position: event.tick / props.tempoMap.ticksPerQuarter,
    label: keySignatureLabel(event.fifths, event.mode),
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

function eventAtTick(tick: number): KeySignatureEventState {
  let current = props.events[0] ?? { tick: 0, fifths: 0, mode: "major" as const }
  for (const event of props.events) {
    if (event.tick > tick) break
    current = event
  }
  return current
}

function replaceEvents(events: KeySignatureEventState[], selectedTick: number | null): void {
  const byTick = new Map<number, KeySignatureEventState>()
  for (const event of events) {
    const tick = Math.max(0, Math.round(event.tick))
    byTick.set(tick, {
      tick,
      fifths: Math.min(7, Math.max(-7, Math.round(event.fifths))),
      mode: event.mode === "minor" ? "minor" : "major"
    })
  }
  if (!byTick.has(0)) byTick.set(0, { tick: 0, fifths: 0, mode: "major" })
  emit(
    "replace",
    [...byTick.values()].sort((left, right) => left.tick - right.tick)
  )
  emit("select", selectedTick)
}

function createPoint(position: number): void {
  const tick = Math.max(0, Math.round(position * props.tempoMap.ticksPerQuarter))
  replaceEvents([...props.events, { ...eventAtTick(tick), tick }], tick)
}

function updatePoint(id: string, position: number): void {
  const previousTick = Number(id)
  const nextTick =
    previousTick === 0 ? 0 : Math.max(0, Math.round(position * props.tempoMap.ticksPerQuarter))
  const event = props.events.find((candidate) => candidate.tick === previousTick)
  if (!event) return
  replaceEvents(
    props.events
      .filter((candidate) => candidate.tick !== previousTick)
      .concat({ ...event, tick: nextTick }),
    nextTick
  )
}

function removePoint(id: string): void {
  const tick = Number(id)
  if (tick === 0) return
  replaceEvents(
    props.events.filter((event) => event.tick !== tick),
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
    color="var(--ui-domain-color-b894ff)"
    :expanded="expanded"
    :value-label="t('studio.lanes.key')"
    :position-label="t('studio.lanes.positionLabel')"
    @create="createPoint"
    @update="updatePoint"
    @remove="removePoint"
    @select="emit('select', $event === null ? null : Number($event))"
  />
</template>

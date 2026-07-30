<script setup lang="ts">
import { shallowRef, type CSSProperties } from "vue"
import { useI18n } from "vue-i18n"
import { useEventListener } from "@vueuse/core"
import type { ProjectCommand } from "@yadaw/contracts"
import { midiNoteName } from "../../utils/pianoRoll"
import { usePianoRollEditor } from "./usePianoRollEditor"
import type { NoteGestureItem } from "./usePianoRollGestures"

const props = defineProps<{ viewport: HTMLElement | null }>()

const {
  pianoRollStore,
  visibleNotes,
  pixelsPerTick,
  gridWidth,
  displayedNoteValues,
  trackColor,
  batch
} = usePianoRollEditor()
const { t } = useI18n()

const BAR_WIDTH_PX = 5
const BAR_HIT_TOLERANCE_PX = 3

const laneScroll = shallowRef<HTMLElement | null>(null)

useEventListener(
  () => props.viewport,
  "scroll",
  () => {
    const source = props.viewport
    const target = laneScroll.value
    if (source && target && target.scrollLeft !== source.scrollLeft) {
      target.scrollLeft = source.scrollLeft
    }
  }
)
useEventListener(laneScroll, "scroll", () => {
  const source = laneScroll.value
  const target = props.viewport
  if (source && target && target.scrollLeft !== source.scrollLeft) {
    target.scrollLeft = source.scrollLeft
  }
})

interface VelocityDrag {
  mode: "level" | "paint"
  targets: NoteGestureItem[]
  previews: Map<string, number>
}

const drag = shallowRef<VelocityDrag | null>(null)

const noteKey = (item: NoteGestureItem): string => `${item.clip.id}:${item.note.id}`

function barLeft(item: NoteGestureItem): number {
  return displayedNoteValues(item.clip, item.note).globalStartTick * pixelsPerTick.value
}

function displayedVelocity(item: NoteGestureItem): number {
  return drag.value?.previews.get(noteKey(item)) ?? item.note.velocity
}

function barStyle(item: NoteGestureItem): CSSProperties {
  return {
    left: `${barLeft(item)}px`,
    width: `${BAR_WIDTH_PX}px`,
    height: `${(displayedVelocity(item) / 127) * 100}%`,
    "--note-color": trackColor(item.clip)
  }
}

function lanePoint(event: PointerEvent): { x: number; velocity: number } {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const x = event.clientX - bounds.left
  const ratio = bounds.height > 0 ? 1 - (event.clientY - bounds.top) / bounds.height : 1
  return { x, velocity: Math.max(1, Math.min(127, Math.round(ratio * 127))) }
}

function barsAt(x: number): NoteGestureItem[] {
  return visibleNotes.value.filter((item) => {
    const left = barLeft(item)
    return x >= left - BAR_HIT_TOLERANCE_PX && x <= left + BAR_WIDTH_PX + BAR_HIT_TOLERANCE_PX
  })
}

function applyLevel(current: VelocityDrag, velocity: number): VelocityDrag {
  const previews = new Map(current.previews)
  for (const target of current.targets) {
    if (target.note.velocity !== velocity || previews.has(noteKey(target))) {
      previews.set(noteKey(target), velocity)
    }
  }
  return { ...current, previews }
}

function applyPaint(current: VelocityDrag, x: number, velocity: number): VelocityDrag {
  const previews = new Map(current.previews)
  for (const item of barsAt(x)) previews.set(noteKey(item), velocity)
  return { ...current, previews }
}

function handlePointerDown(event: PointerEvent): void {
  const point = lanePoint(event)
  const hits = barsAt(point.x)
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  if (hits.length === 0) {
    drag.value = { mode: "paint", targets: [], previews: new Map() }
    return
  }
  const selected = pianoRollStore.selectedNoteKeys
  const anySelected = hits.some((item) => selected.has(noteKey(item)))
  const targets = anySelected
    ? visibleNotes.value.filter((item) => selected.has(noteKey(item)))
    : hits
  drag.value = applyLevel({ mode: "level", targets, previews: new Map() }, point.velocity)
}

function handlePointerMove(event: PointerEvent): void {
  const current = drag.value
  if (!current) return
  event.preventDefault()
  const point = lanePoint(event)
  drag.value =
    current.mode === "level"
      ? applyLevel(current, point.velocity)
      : applyPaint(current, point.x, point.velocity)
}

function handlePointerUp(): void {
  const current = drag.value
  drag.value = null
  if (!current) return
  const byClip = new Map<string, Array<{ noteId: string; patch: { velocity: number } }>>()
  for (const item of visibleNotes.value) {
    const velocity = current.previews.get(noteKey(item))
    if (velocity === undefined || velocity === item.note.velocity) continue
    const updates = byClip.get(item.clip.id) ?? []
    updates.push({ noteId: item.note.id, patch: { velocity } })
    byClip.set(item.clip.id, updates)
  }
  if (byClip.size === 0) return
  const commands: ProjectCommand[] = [...byClip].map(([clipId, updates]) => ({
    type: "update-midi-notes",
    clipId,
    updates
  }))
  void batch(commands)
}

function cancelDrag(): void {
  drag.value = null
}

function barAriaLabel(item: NoteGestureItem): string {
  return t("pianoRoll.velocityLane.barLabel", {
    velocity: displayedVelocity(item),
    note: midiNoteName(item.note.key),
    clip: item.clip.name
  })
}
</script>

<template>
  <div class="velocity-lane">
    <div class="lane-header">{{ t("pianoRoll.velocityLane.header") }}</div>
    <div ref="laneScroll" class="lane-scroll">
      <div
        class="lane-canvas"
        :style="{ width: `${gridWidth}px` }"
        role="application"
        :aria-label="t('pianoRoll.velocityLane.ariaLabel')"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="cancelDrag"
      >
        <div
          v-for="item in visibleNotes"
          :key="noteKey(item)"
          class="velocity-bar"
          :class="{
            selected: pianoRollStore.selectedNoteKeys.has(noteKey(item)),
            inactive: item.clip.id !== pianoRollStore.activeClipId
          }"
          :style="barStyle(item)"
          :aria-label="barAriaLabel(item)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.velocity-lane {
  display: flex;
  min-width: 0;
  flex: none;
  height: 110px;
  border-top: 1px solid var(--line-strong);
  background: var(--surface-1);
}

.lane-header {
  flex: none;
  width: 72px;
  padding: var(--ui-space-2) 5px 0 0;
  border-right: 1px solid var(--line-strong);
  color: var(--text-muted);
  background: var(--surface-2);
  text-align: right;
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.lane-scroll {
  min-width: 0;
  flex: 1;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.lane-canvas {
  position: relative;
  height: 100%;
  background: var(--daw-lane);
  touch-action: none;
}

.velocity-bar {
  position: absolute;
  bottom: 0;
  border: 1px solid color-mix(in srgb, var(--note-color) 65%, var(--line-strong));
  border-bottom: 0;
  border-radius: 1px 1px 0 0;
  background: var(--note-color);
  pointer-events: none;
}

.velocity-bar.inactive {
  opacity: 0.4;
}

.velocity-bar.selected {
  outline: 1px solid var(--focus);
  opacity: 1;
}
</style>

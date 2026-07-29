<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, shallowRef, watch } from "vue"
import type { CSSProperties } from "vue"
import { storeToRefs } from "pinia"
import { UiButton, UiSelect } from "@yadaw/ui"
import type { MidiClipState, MidiNotePatch, MidiNoteState, ProjectCommand } from "@yadaw/contracts"
import { useMixerStore } from "../../stores/mixer"
import { usePianoRollStore, type PianoRollNoteRef } from "../../stores/pianoRoll"
import { useTransportStore } from "../../stores/transport"
import {
  MIN_NOTE_TICKS,
  PIANO_ROLL_SNAP_OPTIONS,
  midiNoteName,
  noteGlobalStart,
  planCreatedNotes,
  planExistingNoteEdits,
  snapStep,
  snapTicks
} from "../../utils/pianoRoll"
import {
  barTicksThroughTick,
  beatTicksThroughTick,
  secondsToTick,
  tickToSeconds
} from "../../utils/tempoMap"

const emit = defineEmits<{ close: [] }>()
const mixerStore = useMixerStore()
const pianoRollStore = usePianoRollStore()
const transportStore = useTransportStore()
const { graph } = storeToRefs(mixerStore)

const openClips = computed(() =>
  pianoRollStore.openClipIds
    .map((id) => graph.value.midiClips.find((clip) => clip.id === id))
    .filter((clip): clip is MidiClipState => Boolean(clip))
)
const activeClip = computed(
  () => openClips.value.find((clip) => clip.id === pianoRollStore.activeClipId) ?? null
)

interface NoteGestureItem {
  clip: MidiClipState
  note: MidiNoteState
  globalStartTick: number
}

interface Gesture {
  startX: number
  startY: number
  currentX: number
  currentY: number
  mode: "move" | "resize-left" | "resize-right"
  items: NoteGestureItem[]
}

const gesture = shallowRef<Gesture | null>(null)
const viewport = shallowRef<HTMLElement | null>(null)
const pixelsPerTick = computed(
  () => pianoRollStore.pixelsPerQuarter / graph.value.tempoMap.ticksPerQuarter
)

function editsForGesture(
  current: Gesture,
  clientX: number,
  clientY: number
): Array<
  NoteGestureItem & {
    durationTicks: number
    patch?: Omit<MidiNotePatch, "startTick" | "durationTicks">
  }
> {
  const rawTickDelta = (clientX - current.startX) / pixelsPerTick.value
  const step = snapStep(pianoRollStore.snap)
  const tickDelta = Math.round(rawTickDelta / step) * step
  const rawKeyDelta = -Math.round((clientY - current.startY) / pianoRollStore.rowHeight)
  const minimumStart = Math.min(...current.items.map((item) => item.globalStartTick))
  const minimumKey = Math.min(...current.items.map((item) => item.note.key))
  const maximumKey = Math.max(...current.items.map((item) => item.note.key))
  const moveTickDelta = Math.max(-minimumStart, tickDelta)
  const keyDelta = Math.max(-minimumKey, Math.min(127 - maximumKey, rawKeyDelta))

  return current.items.map((item) => {
    if (current.mode === "resize-right") {
      return {
        ...item,
        durationTicks: Math.max(MIN_NOTE_TICKS, item.note.durationTicks + tickDelta)
      }
    }
    if (current.mode === "resize-left") {
      const requested = Math.min(item.note.durationTicks - MIN_NOTE_TICKS, tickDelta)
      const globalStartTick = Math.max(0, item.globalStartTick + requested)
      const applied = globalStartTick - item.globalStartTick
      return {
        ...item,
        globalStartTick,
        durationTicks: item.note.durationTicks - applied
      }
    }
    return {
      ...item,
      globalStartTick: item.globalStartTick + moveTickDelta,
      durationTicks: item.note.durationTicks,
      patch: { key: item.note.key + keyDelta }
    }
  })
}

const gestureEdits = computed(() => {
  const current = gesture.value
  return current ? editsForGesture(current, current.currentX, current.currentY) : []
})
const gestureNotePreviews = computed(
  () =>
    new Map(
      gestureEdits.value.map((edit) => [
        `${edit.clip.id}:${edit.note.id}`,
        {
          globalStartTick: edit.globalStartTick,
          durationTicks: edit.durationTicks,
          key: edit.patch?.key ?? edit.note.key
        }
      ])
    )
)
const gestureClipRanges = computed(() => {
  const byClip = new Map<string, typeof gestureEdits.value>()
  for (const edit of gestureEdits.value) {
    const values = byClip.get(edit.clip.id) ?? []
    values.push(edit)
    byClip.set(edit.clip.id, values)
  }
  return new Map(
    [...byClip].map(([clipId, edits]) => {
      const clip = edits[0]!.clip
      const plan = planExistingNoteEdits(
        clip,
        edits.map((edit) => ({
          noteId: edit.note.id,
          globalStartTick: edit.globalStartTick,
          durationTicks: edit.durationTicks,
          patch: edit.patch
        }))
      )
      return [clipId, plan]
    })
  )
})
const maximumTick = computed(() =>
  Math.max(
    graph.value.tempoMap.ticksPerQuarter * 4,
    ...openClips.value.map((clip) => {
      const preview = gestureClipRanges.value.get(clip.id)
      return preview ? preview.startTick + preview.lengthTicks : clip.startTick + clip.lengthTicks
    })
  )
)
const gridWidth = computed(() => Math.max(640, maximumTick.value * pixelsPerTick.value + 240))
const canvasHeight = computed(() => 28 + pianoRollStore.rowHeight * 128)
const barTicks = computed(() => barTicksThroughTick(graph.value.tempoMap, maximumTick.value))
const beatTicks = computed(() => beatTicksThroughTick(graph.value.tempoMap, maximumTick.value))
const channelsById = computed(
  () => new Map(graph.value.channels.map((channel) => [channel.id, channel]))
)
const visibleNotes = computed(() =>
  openClips.value.flatMap((clip) =>
    clip.notes
      .filter(
        (note) =>
          note.startTick + note.durationTicks > clip.sourceOffsetTicks &&
          note.startTick < clip.sourceOffsetTicks + clip.lengthTicks
      )
      .map((note) => ({ clip, note, globalStartTick: noteGlobalStart(clip, note) }))
  )
)
const selectedItems = computed(() => {
  const selected = pianoRollStore.selectedNoteKeys
  return visibleNotes.value.filter(({ clip, note }) => selected.has(`${clip.id}:${note.id}`))
})
const playheadTick = computed(() =>
  secondsToTick(graph.value.tempoMap, transportStore.playheadSeconds)
)

watch(
  graph,
  (value) => {
    const clips = new Set(value.midiClips.map((clip) => clip.id))
    const notes = new Set(
      value.midiClips.flatMap((clip) => clip.notes.map((note) => `${clip.id}:${note.id}`))
    )
    pianoRollStore.reconcile(clips, notes)
  },
  { immediate: true }
)

function trackColor(clip: MidiClipState): string {
  return channelsById.value.get(clip.trackId)?.color ?? "var(--ui-signal-midi)"
}

function clipStyle(clip: MidiClipState): CSSProperties {
  const preview = gestureClipRanges.value.get(clip.id)
  const startTick = preview?.startTick ?? clip.startTick
  const lengthTicks = preview?.lengthTicks ?? clip.lengthTicks
  return {
    left: `${startTick * pixelsPerTick.value}px`,
    width: `${Math.max(1, lengthTicks * pixelsPerTick.value)}px`,
    "--clip-color": trackColor(clip)
  }
}

function noteStyle(clip: MidiClipState, note: MidiNoteState): CSSProperties {
  const preview = gestureNotePreviews.value.get(`${clip.id}:${note.id}`)
  const globalStartTick = preview?.globalStartTick ?? noteGlobalStart(clip, note)
  const durationTicks = preview?.durationTicks ?? note.durationTicks
  const key = preview?.key ?? note.key
  return {
    left: `${globalStartTick * pixelsPerTick.value}px`,
    top: `${(127 - key) * pianoRollStore.rowHeight + 1}px`,
    width: `${Math.max(2, durationTicks * pixelsPerTick.value)}px`,
    height: `${Math.max(4, pianoRollStore.rowHeight - 2)}px`,
    "--note-color": trackColor(clip)
  }
}

function displayedNoteValues(
  clip: MidiClipState,
  note: MidiNoteState
): { globalStartTick: number; durationTicks: number; key: number } {
  return (
    gestureNotePreviews.value.get(`${clip.id}:${note.id}`) ?? {
      globalStartTick: noteGlobalStart(clip, note),
      durationTicks: note.durationTicks,
      key: note.key
    }
  )
}

function noteAriaLabel(clip: MidiClipState, note: MidiNoteState): string {
  const value = displayedNoteValues(clip, note)
  return `${midiNoteName(value.key)}, start ${value.globalStartTick}, duration ${value.durationTicks}, velocity ${note.velocity}, ${clip.name}`
}

function keyStyle(key: number): CSSProperties {
  return {
    top: `${(127 - key) * pianoRollStore.rowHeight}px`,
    height: `${pianoRollStore.rowHeight}px`
  }
}

function isBlackKey(key: number): boolean {
  return [1, 3, 6, 8, 10].includes(key % 12)
}

function batch(commands: ProjectCommand[]): Promise<boolean> {
  const useful = commands.filter(
    (command) => command.type !== "batch" || command.commands.length > 0
  )
  if (useful.length === 0) return Promise.resolve(true)
  return mixerStore.execute(useful.length === 1 ? useful[0]! : { type: "batch", commands: useful })
}

function commandsForEdits(
  values: Array<{
    clip: MidiClipState
    note: MidiNoteState
    globalStartTick: number
    durationTicks: number
    patch?: Omit<MidiNotePatch, "startTick" | "durationTicks">
  }>
): ProjectCommand[] {
  const byClip = new Map<string, typeof values>()
  for (const value of values) {
    const group = byClip.get(value.clip.id) ?? []
    group.push(value)
    byClip.set(value.clip.id, group)
  }
  return [...byClip.values()].flatMap(
    (group) =>
      planExistingNoteEdits(
        group[0]!.clip,
        group.map((value) => ({
          noteId: value.note.id,
          globalStartTick: value.globalStartTick,
          durationTicks: value.durationTicks,
          patch: value.patch
        }))
      ).commands
  )
}

function changeTimeZoom(factor: number): void {
  pianoRollStore.pixelsPerQuarter = Math.max(
    40,
    Math.min(960, Math.round(pianoRollStore.pixelsPerQuarter * factor))
  )
}

function beginNoteGesture(
  event: PointerEvent,
  clip: MidiClipState,
  note: MidiNoteState,
  mode: Gesture["mode"]
): void {
  event.stopPropagation()
  const reference = { clipId: clip.id, noteId: note.id }
  const key = `${clip.id}:${note.id}`
  suppressedNoteClickKey = key
  if (!pianoRollStore.selectedNoteKeys.has(key)) {
    pianoRollStore.selectNote(reference, event.ctrlKey || event.metaKey)
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  gesture.value = {
    startX: event.clientX,
    startY: event.clientY,
    currentX: event.clientX,
    currentY: event.clientY,
    mode,
    items: selectedItems.value.map((item) => ({ ...item }))
  }
}

function updateNoteGesture(event: PointerEvent): void {
  const current = gesture.value
  if (!current) return
  event.preventDefault()
  gesture.value = { ...current, currentX: event.clientX, currentY: event.clientY }
}

function finishNoteGesture(event: PointerEvent): void {
  const current = gesture.value
  gesture.value = null
  if (!current) return
  const edits = editsForGesture(current, event.clientX, event.clientY).filter(
    (item) =>
      item.globalStartTick !== noteGlobalStart(item.clip, item.note) ||
      item.durationTicks !== item.note.durationTicks ||
      (item.patch?.key ?? item.note.key) !== item.note.key
  )
  if (edits.length > 0) void batch(commandsForEdits(edits))
  const key = suppressedNoteClickKey
  window.setTimeout(() => {
    if (suppressedNoteClickKey === key) suppressedNoteClickKey = null
  }, 0)
}

function cancelNoteGesture(): void {
  gesture.value = null
  suppressedNoteClickKey = null
}

let suppressedNoteClickKey: string | null = null
function handleNoteClick(event: MouseEvent, clip: MidiClipState, note: MidiNoteState): void {
  const key = `${clip.id}:${note.id}`
  if (suppressedNoteClickKey === key) {
    suppressedNoteClickKey = null
    return
  }
  const additive = event.ctrlKey || event.metaKey
  if (!pianoRollStore.selectedNoteKeys.has(key) || additive) {
    pianoRollStore.selectNote({ clipId: clip.id, noteId: note.id }, additive)
  }
}

function gridPoint(event: PointerEvent): { tick: number; key: number } {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const tick = snapTicks((event.clientX - bounds.left) / pixelsPerTick.value, pianoRollStore.snap)
  const key = Math.max(
    0,
    Math.min(127, 127 - Math.floor((event.clientY - bounds.top) / pianoRollStore.rowHeight))
  )
  return { tick, key }
}

function handleGridPointerDown(event: PointerEvent): void {
  const point = gridPoint(event)
  pianoRollStore.editCursorTick = point.tick
  pianoRollStore.editCursorKey = point.key
  if (pianoRollStore.tool !== "draw" || !activeClip.value) {
    pianoRollStore.clearNoteSelection()
    return
  }
  const targetClip = activeClip.value
  const durationTicks = pianoRollStore.snap === "off" ? 240 : snapStep(pianoRollStore.snap)
  const noteId = crypto.randomUUID()
  const plan = planCreatedNotes(targetClip, [
    {
      id: noteId,
      globalStartTick: point.tick,
      durationTicks,
      channel: 0,
      key: point.key,
      velocity: 100,
      releaseVelocity: 0
    }
  ])
  void batch(plan.commands).then((created) => {
    if (created) pianoRollStore.selectNote({ clipId: targetClip.id, noteId })
  })
}

function deleteSelected(): void {
  const byClip = new Map<string, string[]>()
  for (const value of pianoRollStore.selectedNotes) {
    const ids = byClip.get(value.clipId) ?? []
    ids.push(value.noteId)
    byClip.set(value.clipId, ids)
  }
  const commands: ProjectCommand[] = [...byClip].map(([clipId, noteIds]) => ({
    type: "delete-midi-notes",
    clipId,
    noteIds
  }))
  void batch(commands).then((deleted) => {
    if (deleted) pianoRollStore.clearNoteSelection()
  })
}

function copySelected(): void {
  if (selectedItems.value.length === 0) return
  const first = Math.min(...selectedItems.value.map((item) => item.globalStartTick))
  pianoRollStore.clipboard = selectedItems.value.map(({ note, globalStartTick }) => ({
    offsetTick: globalStartTick - first,
    durationTicks: note.durationTicks,
    channel: note.channel,
    key: note.key,
    velocity: note.velocity,
    releaseVelocity: note.releaseVelocity
  }))
}

function cutSelected(): void {
  copySelected()
  deleteSelected()
}

function paste(): void {
  const clip = activeClip.value
  if (!clip || pianoRollStore.clipboard.length === 0) return
  const ids: PianoRollNoteRef[] = []
  const plan = planCreatedNotes(
    clip,
    pianoRollStore.clipboard.map((note) => {
      const id = crypto.randomUUID()
      ids.push({ clipId: clip.id, noteId: id })
      return {
        id,
        globalStartTick: pianoRollStore.editCursorTick + note.offsetTick,
        durationTicks: note.durationTicks,
        channel: note.channel,
        key: note.key,
        velocity: note.velocity,
        releaseVelocity: note.releaseVelocity
      }
    })
  )
  void batch(plan.commands).then((created) => {
    if (created) pianoRollStore.setSelectedNotes(ids)
  })
}

function selectAll(): void {
  pianoRollStore.setSelectedNotes(
    visibleNotes.value.map(({ clip, note }) => ({ clipId: clip.id, noteId: note.id }))
  )
}

function applyInspector(field: string, raw: string): void {
  if (selectedItems.value.length === 0 || raw.trim() === "") return
  const value = Math.round(Number(raw))
  if (!Number.isFinite(value)) return
  const edits = selectedItems.value.map((item) => {
    const patch: Omit<MidiNotePatch, "startTick" | "durationTicks"> = {}
    let globalStartTick = item.globalStartTick
    let durationTicks = item.note.durationTicks
    if (field === "start") globalStartTick = Math.max(0, value)
    else if (field === "duration") durationTicks = Math.max(MIN_NOTE_TICKS, value)
    else if (field === "key") patch.key = Math.max(0, Math.min(127, value))
    else if (field === "channel") patch.channel = Math.max(0, Math.min(15, value - 1))
    else if (field === "velocity") patch.velocity = Math.max(1, Math.min(127, value))
    else if (field === "releaseVelocity") {
      patch.releaseVelocity = Math.max(0, Math.min(127, value))
    }
    return { ...item, globalStartTick, durationTicks, patch }
  })
  void batch(commandsForEdits(edits))
}

function commonValue(field: string): string {
  if (selectedItems.value.length === 0) return ""
  const values = selectedItems.value.map((item) => {
    const preview = gestureNotePreviews.value.get(`${item.clip.id}:${item.note.id}`)
    if (field === "start") return preview?.globalStartTick ?? item.globalStartTick
    if (field === "duration") return preview?.durationTicks ?? item.note.durationTicks
    if (field === "channel") return item.note.channel + 1
    if (field === "key") return preview?.key ?? item.note.key
    return item.note[field as "key" | "velocity" | "releaseVelocity"]
  })
  return values.every((value) => value === values[0]) ? String(values[0]) : ""
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
}

function moveSelection(deltaTick: number, deltaKey: number, resize = false): void {
  const edits = selectedItems.value.map((item) =>
    resize
      ? {
          ...item,
          durationTicks: Math.max(MIN_NOTE_TICKS, item.note.durationTicks + deltaTick)
        }
      : {
          ...item,
          globalStartTick: Math.max(0, item.globalStartTick + deltaTick),
          durationTicks: item.note.durationTicks,
          patch: { key: Math.max(0, Math.min(127, item.note.key + deltaKey)) }
        }
  )
  void batch(commandsForEdits(edits))
}

function handleKeydown(event: KeyboardEvent): void {
  if (isEditableTarget(event.target)) return
  const modifier = event.ctrlKey || event.metaKey
  if (modifier && event.code === "KeyC") copySelected()
  else if (modifier && event.code === "KeyX") cutSelected()
  else if (modifier && event.code === "KeyV") paste()
  else if (modifier && event.code === "KeyA") selectAll()
  else if (event.code === "Delete" || event.code === "Backspace") deleteSelected()
  else if (event.code === "ArrowUp") moveSelection(0, 1)
  else if (event.code === "ArrowDown") moveSelection(0, -1)
  else if (event.code === "ArrowLeft") {
    moveSelection(-snapStep(pianoRollStore.snap), 0, event.altKey)
  } else if (event.code === "ArrowRight") {
    moveSelection(snapStep(pianoRollStore.snap), 0, event.altKey)
  } else if (event.code === "Escape") pianoRollStore.clearNoteSelection()
  else return
  event.preventDefault()
}

let unregisterEditCommands: (() => void) | null = null
onMounted(() => {
  unregisterEditCommands = pianoRollStore.registerEditCommandHandler((command) => {
    if (command === "copy") copySelected()
    else if (command === "cut") cutSelected()
    else if (command === "paste") paste()
    else selectAll()
  })
  void nextTick(() => {
    const focusKey = activeClip.value?.notes[0]?.key ?? 60
    const element = viewport.value
    if (element) {
      element.scrollTop = Math.max(
        0,
        (127 - focusKey) * pianoRollStore.rowHeight - element.clientHeight / 2
      )
    }
  })
})
onUnmounted(() => unregisterEditCommands?.())

function close(): void {
  pianoRollStore.closeEditor()
  emit("close")
}
</script>

<template>
  <section
    class="piano-roll"
    aria-label="Piano roll editor"
    @focusin="pianoRollStore.editorFocused = true"
    @focusout="pianoRollStore.editorFocused = false"
    @keydown="handleKeydown"
  >
    <header class="toolbar">
      <div class="dock-tabs" role="tablist" aria-label="Lower dock">
        <slot name="tabs" />
      </div>
      <div class="tools" role="group" aria-label="Piano roll tools">
        <UiButton
          size="sm"
          :variant="pianoRollStore.tool === 'select' ? 'primary' : 'ghost'"
          :aria-pressed="pianoRollStore.tool === 'select'"
          @click="pianoRollStore.tool = 'select'"
        >
          Select
        </UiButton>
        <UiButton
          size="sm"
          :variant="pianoRollStore.tool === 'draw' ? 'primary' : 'ghost'"
          :aria-pressed="pianoRollStore.tool === 'draw'"
          @click="pianoRollStore.tool = 'draw'"
        >
          Draw
        </UiButton>
      </div>
      <label class="snap-control">
        <span>Snap</span>
        <UiSelect
          v-model="pianoRollStore.snap"
          size="sm"
          :options="PIANO_ROLL_SNAP_OPTIONS"
          aria-label="Note snap resolution"
        />
      </label>
      <div class="time-zoom" role="group" aria-label="Piano roll time zoom">
        <UiButton
          size="sm"
          variant="ghost"
          aria-label="Zoom piano roll time out"
          @click="changeTimeZoom(0.8)"
        >
          −
        </UiButton>
        <UiButton
          size="sm"
          variant="ghost"
          aria-label="Zoom piano roll time in"
          @click="changeTimeZoom(1.25)"
        >
          +
        </UiButton>
      </div>
      <div class="clip-chips" aria-label="Editable MIDI clips">
        <button
          v-for="clip in openClips"
          :key="clip.id"
          type="button"
          :class="['clip-chip', { active: clip.id === pianoRollStore.activeClipId }]"
          :style="{ '--clip-color': trackColor(clip) }"
          :aria-pressed="clip.id === pianoRollStore.activeClipId"
          @click="pianoRollStore.activateClip(clip.id)"
        >
          {{ clip.name }}
        </button>
      </div>
      <UiButton size="sm" variant="ghost" aria-label="Close piano roll" @click="close">
        Close
      </UiButton>
    </header>

    <div class="inspector" aria-label="Selected note properties">
      <span class="selection-summary">
        {{ selectedItems.length }} note{{ selectedItems.length === 1 ? "" : "s" }}
      </span>
      <label
        v-for="field in ['key', 'start', 'duration', 'channel', 'velocity', 'releaseVelocity']"
        :key="field"
      >
        <span>{{
          {
            key: "Pitch",
            start: "Start tick",
            duration: "Duration",
            channel: "Channel",
            velocity: "Velocity",
            releaseVelocity: "Release"
          }[field]
        }}</span>
        <input
          type="number"
          :min="field === 'duration' || field === 'velocity' || field === 'channel' ? 1 : 0"
          :max="
            field === 'key' || field === 'velocity' || field === 'releaseVelocity'
              ? 127
              : field === 'channel'
                ? 16
                : undefined
          "
          :value="commonValue(field)"
          placeholder="—"
          :disabled="selectedItems.length === 0"
          @change="applyInspector(field, ($event.target as HTMLInputElement).value)"
        />
      </label>
      <span class="resolution">Resolution 1/3840 note · integer ticks</span>
    </div>

    <div ref="viewport" class="viewport" tabindex="0" aria-label="Piano roll note grid">
      <div class="canvas" :style="{ width: `${gridWidth + 72}px`, height: `${canvasHeight}px` }">
        <div class="ruler-corner" />
        <div class="ruler" :style="{ width: `${gridWidth}px` }">
          <button
            v-for="(tick, index) in barTicks"
            :key="`bar-${tick}`"
            type="button"
            class="ruler-mark bar"
            :style="{ left: `${tick * pixelsPerTick}px` }"
            @click="transportStore.seek(tickToSeconds(graph.tempoMap, tick))"
          >
            {{ index + 1 }}
          </button>
        </div>
        <div class="keyboard">
          <button
            v-for="key in 128"
            :key="key - 1"
            type="button"
            :class="['piano-key', { black: isBlackKey(key - 1) }]"
            :style="keyStyle(key - 1)"
            :aria-label="midiNoteName(key - 1)"
            @click="pianoRollStore.editCursorKey = key - 1"
          >
            {{ (key - 1) % 12 === 0 ? midiNoteName(key - 1) : "" }}
          </button>
        </div>
        <div
          class="grid"
          :style="{
            width: `${gridWidth}px`,
            height: `${pianoRollStore.rowHeight * 128}px`,
            '--row-height': `${pianoRollStore.rowHeight}px`,
            '--beat-width': `${graph.tempoMap.ticksPerQuarter * pixelsPerTick}px`
          }"
          @pointerdown.self="handleGridPointerDown"
        >
          <i
            v-for="key in 128"
            :key="`pitch-row-${key - 1}`"
            :class="['pitch-row', { black: isBlackKey(key - 1) }]"
            :style="keyStyle(key - 1)"
            :data-key="key - 1"
            aria-hidden="true"
          />
          <i
            v-for="tick in beatTicks"
            :key="`beat-${tick}`"
            class="beat-line"
            :style="{ left: `${tick * pixelsPerTick}px` }"
          />
          <i
            v-for="tick in barTicks"
            :key="`bar-line-${tick}`"
            class="bar-line"
            :style="{ left: `${tick * pixelsPerTick}px` }"
          />
          <div
            v-for="clip in openClips"
            :key="`range-${clip.id}`"
            :class="['clip-range', { active: clip.id === pianoRollStore.activeClipId }]"
            :style="clipStyle(clip)"
          />
          <button
            v-for="{ clip, note } in visibleNotes"
            :key="`${clip.id}:${note.id}`"
            type="button"
            class="note"
            :class="{
              selected: pianoRollStore.selectedNoteKeys.has(`${clip.id}:${note.id}`),
              inactive: clip.id !== pianoRollStore.activeClipId,
              previewing: gestureNotePreviews.has(`${clip.id}:${note.id}`)
            }"
            :style="noteStyle(clip, note)"
            :aria-label="noteAriaLabel(clip, note)"
            :aria-pressed="pianoRollStore.selectedNoteKeys.has(`${clip.id}:${note.id}`)"
            @click.stop="handleNoteClick($event, clip, note)"
            @pointerdown="beginNoteGesture($event, clip, note, 'move')"
            @pointermove="updateNoteGesture"
            @pointerup="finishNoteGesture"
            @pointercancel="cancelNoteGesture"
          >
            <span
              class="resize-handle left"
              data-edge="left"
              @pointerdown.stop="beginNoteGesture($event, clip, note, 'resize-left')"
              @pointermove.stop="updateNoteGesture"
              @pointerup.stop="finishNoteGesture"
              @pointercancel.stop="cancelNoteGesture"
            />
            <span class="note-label">
              {{ midiNoteName(displayedNoteValues(clip, note).key) }}
            </span>
            <span
              class="resize-handle right"
              data-edge="right"
              @pointerdown.stop="beginNoteGesture($event, clip, note, 'resize-right')"
              @pointermove.stop="updateNoteGesture"
              @pointerup.stop="finishNoteGesture"
              @pointercancel.stop="cancelNoteGesture"
            />
          </button>
          <div
            class="playhead"
            :style="{ left: `${playheadTick * pixelsPerTick}px` }"
            aria-hidden="true"
          />
        </div>
      </div>
    </div>
    <p v-if="mixerStore.error" class="error" role="alert">{{ mixerStore.error }}</p>
  </section>
</template>

<style scoped src="./PianoRollDock.css"></style>

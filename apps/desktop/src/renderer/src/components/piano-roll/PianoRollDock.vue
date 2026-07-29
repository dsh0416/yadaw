<script setup lang="ts">
import { nextTick, onMounted, provide, shallowRef } from "vue"
import { createPianoRollEditor, pianoRollEditorKey } from "./usePianoRollEditor"
import PianoRollToolbar from "./PianoRollToolbar.vue"
import PianoRollInspector from "./PianoRollInspector.vue"
import PianoRollGrid from "./PianoRollGrid.vue"
import PianoRollVelocityLane from "./PianoRollVelocityLane.vue"

const emit = defineEmits<{ close: [] }>()
const editor = createPianoRollEditor()
provide(pianoRollEditorKey, editor)
const { pianoRollStore } = editor

const viewport = shallowRef<HTMLElement | null>(null)

const RULER_HEIGHT_PX = 28
const KEYBOARD_WIDTH_PX = 72

onMounted(() => {
  void nextTick(() => {
    const focusKey = editor.activeClip.value?.notes[0]?.key ?? 60
    const element = viewport.value
    if (element) {
      element.scrollTop = Math.max(
        0,
        (127 - focusKey) * pianoRollStore.rowHeight - element.clientHeight / 2
      )
      const clip = editor.activeClip.value
      if (clip) {
        element.scrollLeft = Math.max(
          0,
          clip.startTick * editor.pixelsPerTick.value +
            KEYBOARD_WIDTH_PX -
            element.clientWidth / 2
        )
      }
    }
  })
})

function handleWheel(event: WheelEvent): void {
  if (!(event.ctrlKey || event.metaKey)) return
  const element = viewport.value
  if (!element) return
  event.preventDefault()
  const bounds = element.getBoundingClientRect()
  if (event.altKey) {
    const contentY =
      event.clientY - bounds.top + element.scrollTop - RULER_HEIGHT_PX
    const row = contentY / pianoRollStore.rowHeight
    const previous = pianoRollStore.rowHeight
    pianoRollStore.setRowHeight(previous + (event.deltaY < 0 ? 2 : -2))
    const next = pianoRollStore.rowHeight
    if (next !== previous) element.scrollTop += row * (next - previous)
    return
  }
  const contentX = event.clientX - bounds.left + element.scrollLeft - KEYBOARD_WIDTH_PX
  const previousPixelsPerTick = editor.pixelsPerTick.value
  const tick = contentX / previousPixelsPerTick
  pianoRollStore.setPixelsPerQuarter(
    pianoRollStore.pixelsPerQuarter * (event.deltaY < 0 ? 1.25 : 0.8)
  )
  const nextPixelsPerTick = editor.pixelsPerTick.value
  if (nextPixelsPerTick !== previousPixelsPerTick) {
    element.scrollLeft += tick * (nextPixelsPerTick - previousPixelsPerTick)
  }
}

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
    @keydown="editor.handleKeydown"
  >
    <PianoRollToolbar class="toolbar-area" @close="close" />
    <PianoRollInspector class="inspector-area" />
    <div class="editor-main">
      <div
        ref="viewport"
        class="viewport"
        tabindex="0"
        aria-label="Piano roll note grid"
        @wheel="handleWheel"
      >
        <PianoRollGrid />
      </div>
      <PianoRollVelocityLane v-if="pianoRollStore.showVelocityLane" :viewport="viewport" />
    </div>
    <p v-if="editor.mixerError.value" class="error" role="alert">{{ editor.mixerError.value }}</p>
  </section>
</template>

<style scoped>
.piano-roll {
  position: relative;
  isolation: isolate;
  display: grid;
  grid-template-rows: 39px minmax(0, 1fr);
  grid-template-columns: 168px minmax(0, 1fr);
  grid-template-areas:
    "toolbar toolbar"
    "inspector viewport";
  min-width: 0;
  min-height: 0;
  height: 100%;
  overflow: hidden;
  border-top: 1px solid var(--line-strong);
  background: var(--daw-workspace);
}

.toolbar-area {
  grid-area: toolbar;
}

.inspector-area {
  grid-area: inspector;
}

.editor-main {
  display: flex;
  grid-area: viewport;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
}

.viewport {
  position: relative;
  z-index: var(--ui-z-local-base);
  isolation: isolate;
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  outline: none;
}

.viewport:focus-visible {
  box-shadow: var(--ui-focus-ring);
}

.error {
  position: absolute;
  right: var(--ui-space-3);
  bottom: var(--ui-space-2);
  margin: 0;
  padding: var(--ui-space-2);
  color: var(--ui-color-danger);
  background: var(--surface-1);
}
</style>

<script setup lang="ts">
import { nextTick, onMounted, provide, shallowRef } from "vue"
import { createPianoRollEditor, pianoRollEditorKey } from "./usePianoRollEditor"
import PianoRollToolbar from "./PianoRollToolbar.vue"
import PianoRollInspector from "./PianoRollInspector.vue"
import PianoRollGrid from "./PianoRollGrid.vue"

const emit = defineEmits<{ close: [] }>()
const editor = createPianoRollEditor()
provide(pianoRollEditorKey, editor)
const { pianoRollStore } = editor

const viewport = shallowRef<HTMLElement | null>(null)

onMounted(() => {
  void nextTick(() => {
    const focusKey = editor.activeClip.value?.notes[0]?.key ?? 60
    const element = viewport.value
    if (element) {
      element.scrollTop = Math.max(
        0,
        (127 - focusKey) * pianoRollStore.rowHeight - element.clientHeight / 2
      )
    }
  })
})

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
    <div
      ref="viewport"
      class="viewport"
      tabindex="0"
      aria-label="Piano roll note grid"
    >
      <PianoRollGrid />
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

.viewport {
  position: relative;
  z-index: var(--ui-z-local-base);
  isolation: isolate;
  grid-area: viewport;
  min-width: 0;
  min-height: 0;
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

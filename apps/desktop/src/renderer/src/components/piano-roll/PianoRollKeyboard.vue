<script setup lang="ts">
import { midiNoteName } from "../../utils/pianoRoll"
import { usePianoRollEditor } from "./usePianoRollEditor"

const { pianoRollStore, keyStyle, isBlackKey } = usePianoRollEditor()
</script>

<template>
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
</template>

<style scoped>
.keyboard {
  position: sticky;
  z-index: var(--ui-z-local-sticky);
  left: 0;
  width: 72px;
  height: calc(var(--row-height, 18px) * 128);
  border-right: 1px solid var(--line-strong);
  background: var(--surface-2);
}

.piano-key {
  position: absolute;
  left: 0;
  width: 72px;
  padding: 0 5px;
  border: 0;
  border-bottom: 1px solid var(--line-soft);
  color: var(--text-muted);
  background: var(--surface-2);
  text-align: right;
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.piano-key.black {
  width: 47px;
  border-right: 1px solid var(--line-strong);
  color: var(--text-secondary);
  background: var(--surface-sunken);
}
</style>

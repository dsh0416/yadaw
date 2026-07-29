<script setup lang="ts">
import { usePianoRollEditor } from "./usePianoRollEditor"
import PianoRollKeyboard from "./PianoRollKeyboard.vue"
import PianoRollNote from "./PianoRollNote.vue"

const {
  pianoRollStore,
  graph,
  openClips,
  visibleNotes,
  pixelsPerTick,
  gridWidth,
  canvasHeight,
  barTicks,
  beatTicks,
  playheadTick,
  clipStyle,
  keyStyle,
  isBlackKey,
  seekToTick,
  handleGridPointerDown
} = usePianoRollEditor()
</script>

<template>
  <div
    class="canvas"
    :style="{
      width: `${gridWidth + 72}px`,
      height: `${canvasHeight}px`,
      '--row-height': `${pianoRollStore.rowHeight}px`
    }"
  >
    <div class="ruler-corner" />
    <div class="ruler" :style="{ width: `${gridWidth}px` }">
      <button
        v-for="(tick, index) in barTicks"
        :key="`bar-${tick}`"
        type="button"
        class="ruler-mark bar"
        :style="{ left: `${tick * pixelsPerTick}px` }"
        @click="seekToTick(tick)"
      >
        {{ index + 1 }}
      </button>
    </div>
    <PianoRollKeyboard />
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
      <PianoRollNote
        v-for="{ clip, note } in visibleNotes"
        :key="`${clip.id}:${note.id}`"
        :clip="clip"
        :note="note"
      />
      <div
        class="playhead"
        :style="{ left: `${playheadTick * pixelsPerTick}px` }"
        aria-hidden="true"
      />
    </div>
  </div>
</template>

<style scoped>
.canvas {
  position: relative;
  isolation: isolate;
}

.ruler-corner {
  position: sticky;
  z-index: var(--ui-z-local-controls);
  top: 0;
  left: 0;
  width: 72px;
  height: 28px;
  border-right: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-2);
}

.ruler {
  position: sticky;
  z-index: var(--ui-z-local-sticky);
  top: 0;
  left: 72px;
  height: 28px;
  margin-top: -28px;
  margin-left: 72px;
  border-bottom: 1px solid var(--line-strong);
  background: var(--surface-2);
}

.ruler-mark {
  position: absolute;
  top: 0;
  height: 28px;
  padding: 2px 4px;
  border: 0;
  border-left: 1px solid var(--daw-grid-line);
  color: var(--text-muted);
  background: transparent;
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.grid {
  position: absolute;
  z-index: var(--ui-z-local-base);
  isolation: isolate;
  top: 28px;
  left: 72px;
  overflow: hidden;
  background:
    repeating-linear-gradient(
      to bottom,
      transparent 0,
      transparent calc(var(--row-height) - 1px),
      var(--line-soft) calc(var(--row-height) - 1px),
      var(--line-soft) var(--row-height)
    ),
    var(--daw-lane);
}

.pitch-row {
  position: absolute;
  right: 0;
  left: 0;
  border-bottom: 1px solid var(--line-soft);
  pointer-events: none;
}

.pitch-row.black {
  background: color-mix(in srgb, var(--surface-sunken) 46%, transparent);
}

.bar-line,
.beat-line {
  position: absolute;
  z-index: var(--ui-z-local-base);
  top: 0;
  bottom: 0;
  width: 1px;
  pointer-events: none;
}

.bar-line {
  background: var(--daw-grid-line);
}

.beat-line {
  background: color-mix(in srgb, var(--daw-grid-line) 35%, transparent);
}

.clip-range {
  position: absolute;
  z-index: var(--ui-z-local-base);
  top: 0;
  bottom: 0;
  border-right: 1px dashed var(--clip-color);
  border-left: 1px dashed var(--clip-color);
  background: color-mix(in srgb, var(--clip-color) 4%, transparent);
  pointer-events: none;
}

.clip-range.active {
  background: color-mix(in srgb, var(--clip-color) 8%, transparent);
}

.playhead {
  position: absolute;
  z-index: var(--ui-z-local-controls);
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--ui-signal-recording);
  pointer-events: none;
}
</style>

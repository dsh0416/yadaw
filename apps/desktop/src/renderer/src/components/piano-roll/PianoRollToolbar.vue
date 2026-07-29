<script setup lang="ts">
import { UiButton, UiSelect } from "@yadaw/ui"
import { PIANO_ROLL_SNAP_OPTIONS } from "../../utils/pianoRoll"
import { usePianoRollEditor } from "./usePianoRollEditor"

const emit = defineEmits<{ close: [] }>()
const { pianoRollStore, openClips, trackColor } = usePianoRollEditor()

function changeTimeZoom(factor: number): void {
  pianoRollStore.setPixelsPerQuarter(pianoRollStore.pixelsPerQuarter * factor)
}
</script>

<template>
  <header class="toolbar">
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
      <UiButton
        size="sm"
        :variant="pianoRollStore.tool === 'erase' ? 'primary' : 'ghost'"
        :aria-pressed="pianoRollStore.tool === 'erase'"
        @click="pianoRollStore.tool = 'erase'"
      >
        Erase
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
    <UiButton size="sm" variant="ghost" aria-label="Close piano roll" @click="emit('close')">
      Close
    </UiButton>
  </header>
</template>

<style scoped>
.toolbar {
  position: relative;
  z-index: var(--ui-z-local-header);
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--ui-space-2);
  padding: 4px var(--ui-space-3);
  border-bottom: 1px solid var(--line-soft);
  background: var(--surface-1);
}

.tools,
.time-zoom,
.clip-chips {
  display: flex;
  align-items: center;
  gap: 3px;
}

.snap-control {
  display: grid;
  grid-template-columns: auto 112px;
  align-items: center;
  gap: 5px;
  color: var(--text-muted);
  font: var(--ui-type-size-caption) var(--ui-type-family-data);
}

.clip-chips {
  min-width: 0;
  flex: 1;
  overflow-x: auto;
}

.clip-chip {
  min-height: var(--ui-target-min);
  padding: 0 var(--ui-space-2);
  border: 1px solid var(--line-soft);
  border-left: 3px solid var(--clip-color);
  border-radius: var(--ui-radius-sm);
  color: var(--text-muted);
  background: var(--surface-sunken);
  white-space: nowrap;
}

.clip-chip.active {
  color: var(--text-primary);
  border-color: var(--clip-color);
  background: var(--surface-active);
}
</style>

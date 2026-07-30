<script setup lang="ts">
import {
  UiButton,
  UiChoiceChip,
  UiSegmentedControl,
  UiSelect,
  UiToolbar,
  type UiSegmentedOption
} from "@yadaw/ui"
import { PIANO_ROLL_SNAP_OPTIONS } from "../../utils/pianoRoll"
import { usePianoRollEditor } from "./usePianoRollEditor"

const emit = defineEmits<{ close: [] }>()
const { pianoRollStore, openClips, trackColor } = usePianoRollEditor()

const TOOL_OPTIONS = [
  { label: "Select", value: "select" },
  { label: "Draw", value: "draw" },
  { label: "Erase", value: "erase" }
] satisfies readonly UiSegmentedOption[]

function changeTimeZoom(factor: number): void {
  pianoRollStore.setPixelsPerQuarter(pianoRollStore.pixelsPerQuarter * factor)
}

function changeKeyZoom(delta: number): void {
  pianoRollStore.setRowHeight(pianoRollStore.rowHeight + delta)
}
</script>

<template>
  <UiToolbar as="header" class="toolbar" density="compact" label="Piano roll commands">
    <template #start>
      <UiSegmentedControl
        v-model="pianoRollStore.tool"
        size="compact"
        label="Piano roll tools"
        :options="TOOL_OPTIONS"
      />
      <label class="snap-control">
        <span>Snap</span>
        <UiSelect
          v-model="pianoRollStore.snap"
          size="compact"
          :options="PIANO_ROLL_SNAP_OPTIONS"
          aria-label="Note snap resolution"
        />
      </label>
    </template>
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
    <div class="key-zoom" role="group" aria-label="Piano roll key zoom">
      <UiButton
        size="sm"
        variant="ghost"
        aria-label="Zoom piano roll keys out"
        @click="changeKeyZoom(-2)"
      >
        −
      </UiButton>
      <UiButton
        size="sm"
        variant="ghost"
        aria-label="Zoom piano roll keys in"
        @click="changeKeyZoom(2)"
      >
        +
      </UiButton>
    </div>
    <div class="clip-chips" aria-label="Editable MIDI clips">
      <UiChoiceChip
        v-for="clip in openClips"
        :key="clip.id"
        :label="clip.name"
        :selected="clip.id === pianoRollStore.activeClipId"
        :signal-color="trackColor(clip)"
        @select="pianoRollStore.activateClip(clip.id)"
      />
    </div>
    <template #end>
      <UiButton size="sm" variant="ghost" aria-label="Close piano roll" @click="emit('close')">
        Close
      </UiButton>
    </template>
  </UiToolbar>
</template>

<style scoped>
.toolbar {
  position: relative;
  z-index: var(--ui-z-local-header);
}

.time-zoom,
.key-zoom,
.clip-chips {
  display: flex;
  align-items: center;
  gap: 3px;
}

.snap-control {
  display: grid;
  grid-template-columns: auto 7rem;
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
</style>

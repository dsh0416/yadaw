<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
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
const { t } = useI18n()

const toolOptions = computed(
  () =>
    [
      { label: t("pianoRoll.toolbar.toolSelect"), value: "select" },
      { label: t("pianoRoll.toolbar.toolDraw"), value: "draw" },
      { label: t("pianoRoll.toolbar.toolErase"), value: "erase" }
    ] satisfies readonly UiSegmentedOption[]
)

const snapOptions = computed(() =>
  PIANO_ROLL_SNAP_OPTIONS.map((option) => ({
    value: option.value,
    label: t(`pianoRoll.snap.${option.value}`)
  }))
)

function changeTimeZoom(factor: number): void {
  pianoRollStore.setPixelsPerQuarter(pianoRollStore.pixelsPerQuarter * factor)
}

function changeKeyZoom(delta: number): void {
  pianoRollStore.setRowHeight(pianoRollStore.rowHeight + delta)
}
</script>

<template>
  <UiToolbar class="toolbar" density="compact" :label="t('pianoRoll.toolbar.commands')">
    <template #start>
      <UiSegmentedControl
        v-model="pianoRollStore.tool"
        size="compact"
        :label="t('pianoRoll.toolbar.tools')"
        :options="toolOptions"
      />
      <label class="snap-control">
        <span>{{ t("pianoRoll.toolbar.snap") }}</span>
        <UiSelect
          v-model="pianoRollStore.snap"
          size="compact"
          :options="snapOptions"
          :aria-label="t('pianoRoll.toolbar.snapResolution')"
        />
      </label>
    </template>
    <div class="time-zoom" role="group" :aria-label="t('pianoRoll.toolbar.timeZoom')">
      <UiButton
        size="sm"
        variant="ghost"
        :aria-label="t('pianoRoll.toolbar.zoomTimeOut')"
        @click="changeTimeZoom(0.8)"
      >
        −
      </UiButton>
      <UiButton
        size="sm"
        variant="ghost"
        :aria-label="t('pianoRoll.toolbar.zoomTimeIn')"
        @click="changeTimeZoom(1.25)"
      >
        +
      </UiButton>
    </div>
    <div class="key-zoom" role="group" :aria-label="t('pianoRoll.toolbar.keyZoom')">
      <UiButton
        size="sm"
        variant="ghost"
        :aria-label="t('pianoRoll.toolbar.zoomKeysOut')"
        @click="changeKeyZoom(-2)"
      >
        −
      </UiButton>
      <UiButton
        size="sm"
        variant="ghost"
        :aria-label="t('pianoRoll.toolbar.zoomKeysIn')"
        @click="changeKeyZoom(2)"
      >
        +
      </UiButton>
    </div>
    <div class="clip-chips" :aria-label="t('pianoRoll.toolbar.editableClips')">
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
      <UiButton
        size="sm"
        variant="ghost"
        :aria-label="t('pianoRoll.toolbar.close')"
        @click="emit('close')"
      >
        {{ t("pianoRoll.toolbar.closeLabel") }}
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

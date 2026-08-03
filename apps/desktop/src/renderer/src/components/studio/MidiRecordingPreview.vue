<script setup lang="ts">
import { computed } from "vue"
import { useI18n } from "vue-i18n"
import type { MidiRecordingPreviewTake, TempoMapSnapshot } from "@heron/contracts"

const props = defineProps<{
  take: MidiRecordingPreviewTake | null
  startTick: number
  positionTick: number
  tempoMap: TempoMapSnapshot
  pixelsPerQuarter: number
  trackColor: string
}>()

const { t } = useI18n()
const pixelsPerTick = computed(() => props.pixelsPerQuarter / props.tempoMap.ticksPerQuarter)
const previewStyle = computed(() => ({
  left: `${props.startTick * pixelsPerTick.value}px`,
  width: `${Math.max(12, (props.positionTick - props.startTick) * pixelsPerTick.value)}px`,
  "--track-color": props.trackColor
}))
const accessibleLabel = computed(
  () => `${t("studio.arrangement.recordingAria")}, MIDI, ${props.take?.notes.length ?? 0} notes`
)

function noteStyle(note: MidiRecordingPreviewTake["notes"][number]) {
  return {
    left: `${Math.max(0, note.startTick - props.startTick) * pixelsPerTick.value}px`,
    width: `${Math.max(2, (note.endTick - note.startTick) * pixelsPerTick.value)}px`,
    bottom: `${(note.key / 127) * 72 + 8}%`,
    opacity: String(0.55 + (note.velocity / 127) * 0.45)
  }
}
</script>

<template>
  <div
    class="midi-recording-preview"
    data-testid="midi-recording-preview"
    :style="previewStyle"
    role="img"
    :aria-label="accessibleLabel"
  >
    <span class="preview-heading">
      <i aria-hidden="true" />
      <strong>{{ t("studio.arrangement.newRecording") }}</strong>
    </span>
    <span
      v-for="note in take?.notes ?? []"
      :key="note.id"
      :class="['preview-note', { active: note.active }]"
      :style="noteStyle(note)"
    />
    <span class="capture-edge" aria-hidden="true" />
  </div>
</template>

<style scoped>
.midi-recording-preview {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  top: 5px;
  bottom: 5px;
  min-width: 12px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--record) 76%, white);
  border-radius: 3px;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--record) 24%, var(--surface-sunken)),
    color-mix(in srgb, var(--record) 12%, var(--surface-sunken))
  );
  box-shadow: 0 0 14px color-mix(in srgb, var(--record) 24%, transparent);
  pointer-events: none;
}
.preview-heading {
  position: absolute;
  z-index: var(--ui-z-local-raised);
  top: 0;
  right: 0;
  left: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 3px 5px;
  overflow: hidden;
  background: linear-gradient(180deg, var(--ui-domain-color-111111b8), transparent);
  white-space: nowrap;
}
.preview-heading i {
  width: 6px;
  height: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--record);
  box-shadow: 0 0 5px var(--record);
}
.preview-heading strong {
  overflow: hidden;
  color: var(--ui-domain-color-f7f8f8);
  font: var(--ui-type-weight-semibold) var(--ui-type-size-caption) var(--ui-type-family-data);
  text-overflow: ellipsis;
}
.preview-note {
  position: absolute;
  height: 3px;
  min-width: 2px;
  border-radius: 1px;
  background: color-mix(in srgb, var(--track-color) 45%, var(--ui-domain-color-fff));
  box-shadow: 0 0 3px color-mix(in srgb, var(--track-color) 45%, transparent);
}
.preview-note.active {
  background: var(--ui-domain-color-fff);
  box-shadow: 0 0 5px color-mix(in srgb, var(--record) 70%, transparent);
}
.capture-edge {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 2px;
  background: color-mix(in srgb, var(--record) 80%, white);
  box-shadow: 0 0 7px var(--record);
}
</style>

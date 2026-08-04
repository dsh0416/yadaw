<script setup lang="ts">
import { useI18n } from "vue-i18n"
import type { MixerChannelPatch, MixerParameterPreview } from "@heron/contracts"
import InlineTrackNameEditor from "../InlineTrackNameEditor.vue"
import TrackHeightResizeHandle from "./TrackHeightResizeHandle.vue"
import TrackQuickControls from "./TrackQuickControls.vue"
import type { ArrangementTrackRow } from "./arrangementWorkspaceTypes"

defineProps<{
  rows: readonly ArrangementTrackRow[]
  selectedChannelId: string | null
  trackHeight: number
}>()

const emit = defineEmits<{
  select: [channelId: string]
  reorder: [index: number, direction: -1 | 1]
  rename: [channelId: string, name: string]
  preview: [preview: MixerParameterPreview]
  updateChannel: [channelId: string, patch: MixerChannelPatch]
  setScale: [trackId: string, scale: number]
  resetScale: [trackId: string]
}>()

const { t } = useI18n()

function handleKeydown(event: KeyboardEvent, index: number): void {
  if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
  event.preventDefault()
  emit("reorder", index, event.key === "ArrowUp" ? -1 : 1)
}

function relayChannelUpdate(channelId: string, patch: MixerChannelPatch): void {
  emit("updateChannel", channelId, patch)
}
</script>

<template>
  <div
    v-for="({ track, scale, meter }, index) in rows"
    :key="track.id"
    :class="['track-header', { selected: track.id === selectedChannelId }]"
    @click="emit('select', track.id)"
    @keydown="handleKeydown($event, index)"
  >
    <span class="track-color" :style="{ background: track.color }" /><strong>{{
      String(index + 1).padStart(2, "0")
    }}</strong>
    <div class="track-copy">
      <InlineTrackNameEditor
        class="track-name-editor"
        :name="track.name"
        :label="t('studio.arrangement.trackRenameLabel', { name: track.name })"
        @rename="emit('rename', track.id, $event)"
      />
    </div>
    <TrackQuickControls
      class="track-quick-controls"
      :channel="track"
      :meter="meter"
      @preview="emit('preview', $event)"
      @update-channel="relayChannelUpdate"
    />
    <TrackHeightResizeHandle
      :base-height="trackHeight"
      :scale="scale"
      :track-name="track.name"
      @set-scale="emit('setScale', track.trackId, $event)"
      @reset="emit('resetScale', track.trackId)"
    />
  </div>
  <div class="track-spacer" aria-hidden="true" />
</template>

<style scoped>
.track-header {
  position: relative;
  display: grid;
  grid-template-columns: 3px 20px minmax(0, 1fr);
  grid-template-rows: minmax(9px, auto) 23px;
  align-content: center;
  align-items: center;
  column-gap: 6px;
  row-gap: 1px;
  padding: 1px 8px;
  border: 0;
  border-bottom: 1px solid var(--line-strong);
  color: var(--text-primary);
  background: var(--daw-track-header);
  text-align: left;
  cursor: pointer;
}
.track-header:hover,
.track-header:focus-within {
  z-index: var(--ui-z-local-selection);
}
.track-header:hover {
  background: var(--daw-track-header-hover);
}
.track-header.selected {
  background: var(--daw-track-header-selected);
  box-shadow: 3px 0 0 var(--accent) inset;
}
.track-header:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: -2px;
}
.track-color {
  grid-row: 1/3;
  align-self: stretch;
  border-radius: 2px;
}
.track-header > strong {
  grid-column: 2;
  grid-row: 1;
  color: var(--text-muted);
  font: var(--ui-type-size-control) var(--ui-type-family-data);
}
.track-copy {
  grid-column: 3;
  grid-row: 1;
  min-width: 0;
}
.track-copy b {
  display: block;
  overflow: hidden;
  font-size: var(--ui-type-size-body-compact);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.track-quick-controls {
  grid-column: 2/4;
  grid-row: 2;
}
.track-spacer {
  background: var(--daw-ruler);
}
.track-name-editor {
  display: block;
  font-size: var(--ui-type-size-body-compact);
  font-weight: var(--ui-type-weight-bold);
}
</style>

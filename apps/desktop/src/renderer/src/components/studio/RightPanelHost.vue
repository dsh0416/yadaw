<script setup lang="ts">
import { shallowRef } from "vue"
import { useEventListener } from "@vueuse/core"
import { useI18n } from "vue-i18n"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import MediaBrowserPanel from "../media-browser/MediaBrowserPanel.vue"
import NotesPanel from "../notes/NotesPanel.vue"

const { t } = useI18n()
const workspaceStore = useStudioWorkspaceStore()
const resizing = shallowRef(false)

function startResize(event: PointerEvent): void {
  resizing.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveResize(event: PointerEvent): void {
  if (resizing.value) workspaceStore.setRightPanelWidth(window.innerWidth - event.clientX)
}

function stopResize(): void {
  resizing.value = false
}

function handleSeparatorKey(event: KeyboardEvent): void {
  if (event.key === "Home") workspaceStore.setRightPanelWidth(320)
  else if (event.key === "ArrowLeft") {
    workspaceStore.setRightPanelWidth(workspaceStore.rightPanelWidth + 10)
  } else if (event.key === "ArrowRight") {
    workspaceStore.setRightPanelWidth(workspaceStore.rightPanelWidth - 10)
  } else return
  event.preventDefault()
}

useEventListener(window, "pointermove", moveResize)
useEventListener(window, "pointerup", stopResize)
</script>

<template>
  <div class="right-panel-host" :style="{ width: `${workspaceStore.rightPanelWidth}px` }">
    <div
      class="right-panel-resizer"
      :class="{ active: resizing }"
      role="separator"
      tabindex="0"
      aria-orientation="vertical"
      :aria-label="t('studio.mediaBrowser.resizeAria')"
      :aria-valuemin="260"
      :aria-valuemax="480"
      :aria-valuenow="workspaceStore.rightPanelWidth"
      @pointerdown="startResize"
      @keydown="handleSeparatorKey"
    />
    <NotesPanel v-if="workspaceStore.activeRightPanel === 'notes'" />
    <MediaBrowserPanel v-else />
  </div>
</template>

<style scoped>
.right-panel-host {
  position: relative;
  min-width: 260px;
  max-width: 480px;
  min-height: 0;
}
.right-panel-resizer {
  position: absolute;
  z-index: var(--ui-z-local-controls);
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: ew-resize;
}
.right-panel-resizer::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 2px;
  width: 1px;
  background: var(--line-strong);
}
.right-panel-resizer:hover::after,
.right-panel-resizer.active::after,
.right-panel-resizer:focus-visible::after {
  background: var(--accent);
}
.right-panel-resizer:focus-visible {
  outline: 0;
}
</style>

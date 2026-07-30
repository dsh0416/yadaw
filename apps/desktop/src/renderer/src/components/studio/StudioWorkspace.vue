<script setup lang="ts">
import { shallowRef } from "vue"
import { useI18n } from "vue-i18n"
import { useEventListener } from "@vueuse/core"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"
import MixerConsole from "../mixer/MixerConsole.vue"
import PianoRollDock from "../piano-roll/PianoRollDock.vue"

const { t } = useI18n()

defineProps<{
  recordingId: string | null
  recordingStartedAt: number | null
  recordingStartFrame: number | null
  recordingError: string
}>()

const workspaceStore = useStudioWorkspaceStore()
const resizing = shallowRef(false)

function startResize(event: PointerEvent): void {
  resizing.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function moveResize(event: PointerEvent): void {
  if (!resizing.value) return
  const shell = (event.currentTarget as Window).document.documentElement
  workspaceStore.setDockHeight(shell.clientHeight - event.clientY - 25)
}

function stopResize(): void {
  resizing.value = false
}

useEventListener(window, "pointermove", moveResize)
useEventListener(window, "pointerup", stopResize)
</script>

<template>
  <section class="studio-workspace">
    <div class="arrangement-mode">
      <ArrangementWorkspace
        :recording-id="recordingId"
        :recording-started-at="recordingStartedAt"
        :recording-start-frame="recordingStartFrame"
        :recording-error="recordingError"
      />
      <div
        v-if="workspaceStore.lowerDockOpen"
        class="dock-resizer"
        :class="{ active: resizing }"
        role="separator"
        :aria-label="t('studio.arrangement.resizeMixerDockAria')"
        @pointerdown="startResize"
      />
      <div v-if="workspaceStore.lowerDockOpen" class="lower-dock" :style="workspaceStore.dockStyle">
        <MixerConsole v-if="workspaceStore.activeLowerDock === 'mixer'" class="mixer-dock" />
        <PianoRollDock v-else @close="workspaceStore.closeLowerDock" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.studio-workspace {
  display: block;
  min-width: 0;
  min-height: 0;
  background: var(--daw-workspace);
  overflow: hidden;
}
.arrangement-mode {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
}
.arrangement-mode > :first-child {
  min-height: 120px;
  flex: 1;
}
.lower-dock {
  display: flex;
  min-height: 0;
  flex: none;
  flex-direction: column;
  overflow: hidden;
}
.mixer-dock {
  min-height: 0;
  flex: none;
  flex: 1;
}
.dock-resizer {
  position: relative;
  z-index: var(--ui-z-local-controls);
  flex: none;
  height: 5px;
  margin-top: -2px;
  border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-soft);
  background: var(--daw-resizer);
  cursor: ns-resize;
}
.dock-resizer::after {
  content: "";
  position: absolute;
  top: 1px;
  left: 50%;
  width: 32px;
  height: 1px;
  transform: translateX(-50%);
  background: var(--text-faint);
}
.dock-resizer.active {
  background: var(--surface-active);
}
</style>

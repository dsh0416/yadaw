<script setup lang="ts">
import { shallowRef } from "vue"
import { useEventListener } from "@vueuse/core"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"
import MixerConsole from "../mixer/MixerConsole.vue"
import PianoRollDock from "../piano-roll/PianoRollDock.vue"
import { usePianoRollStore } from "../../stores/pianoRoll"

defineProps<{
  recordingId: string | null
  recordingStartedAt: number | null
  recordingStartFrame: number | null
  recordingError: string
}>()

const workspaceStore = useStudioWorkspaceStore()
const pianoRollStore = usePianoRollStore()
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
        aria-label="Resize mixer dock"
        @pointerdown="startResize"
      />
      <div v-if="workspaceStore.lowerDockOpen" class="lower-dock" :style="workspaceStore.dockStyle">
        <template v-if="workspaceStore.activeLowerDock === 'mixer'">
          <div class="dock-tabbar" role="tablist" aria-label="Lower dock">
            <button type="button" role="tab" aria-selected="true">Mixer</button>
            <button
              v-if="pianoRollStore.openClipIds.length > 0"
              type="button"
              role="tab"
              aria-selected="false"
              @click="workspaceStore.activateLowerDock('piano-roll')"
            >
              Piano roll
            </button>
          </div>
          <MixerConsole class="mixer-dock" />
        </template>
        <PianoRollDock v-else @close="workspaceStore.activateLowerDock('mixer')">
          <template #tabs>
            <button
              type="button"
              role="tab"
              aria-selected="false"
              @click="workspaceStore.activateLowerDock('mixer')"
            >
              Mixer
            </button>
            <button type="button" role="tab" aria-selected="true">Piano roll</button>
          </template>
        </PianoRollDock>
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
.dock-tabbar {
  display: flex;
  flex: none;
  height: 31px;
  align-items: center;
  gap: 3px;
  padding: 3px var(--ui-space-3);
  border-top: 1px solid var(--line-strong);
  border-bottom: 1px solid var(--line-soft);
  background: var(--surface-1);
}
.dock-tabbar button,
:deep(.dock-tabs button) {
  min-height: var(--ui-target-min);
  padding: 0 var(--ui-space-2);
  border: 1px solid transparent;
  border-radius: var(--ui-radius-sm);
  color: var(--text-muted);
  background: transparent;
}
.dock-tabbar button[aria-selected="true"],
:deep(.dock-tabs button[aria-selected="true"]) {
  color: var(--text-primary);
  border-color: var(--line-soft);
  background: var(--surface-active);
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

<script setup lang="ts">
import { shallowRef } from "vue"
import { useEventListener } from "@vueuse/core"
import { Columns3, PanelBottomClose, PanelBottomOpen, Rows3 } from "@lucide/vue"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import ArrangementWorkspace from "./ArrangementWorkspace.vue"
import MixerConsole from "../mixer/MixerConsole.vue"

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
    <nav class="workspace-switcher" aria-label="Studio workspace">
      <button
        :class="{ active: workspaceStore.mode === 'arrangement' }"
        :aria-pressed="workspaceStore.mode === 'arrangement'"
        @click="workspaceStore.showArrangement"
      ><Rows3 :size="12" />Arrangement</button>
      <button
        :class="{ active: workspaceStore.mode === 'mixer' }"
        :aria-pressed="workspaceStore.mode === 'mixer'"
        @click="workspaceStore.showMixer"
      ><Columns3 :size="12" />Mixer</button>
      <span />
      <button
        v-if="workspaceStore.mode === 'arrangement'"
        :aria-pressed="workspaceStore.mixerDockOpen"
        aria-label="Toggle mixer dock"
        @click="workspaceStore.toggleMixerDock"
      >
        <PanelBottomClose v-if="workspaceStore.mixerDockOpen" :size="13" />
        <PanelBottomOpen v-else :size="13" />
        {{ workspaceStore.mixerDockOpen ? "Hide mixer" : "Show mixer" }}
      </button>
    </nav>

    <div v-show="workspaceStore.mode === 'arrangement'" class="arrangement-mode">
      <ArrangementWorkspace
        :recording-id="recordingId"
        :recording-started-at="recordingStartedAt"
        :recording-start-frame="recordingStartFrame"
        :recording-error="recordingError"
      />
      <div
        v-if="workspaceStore.mixerDockOpen"
        class="dock-resizer"
        :class="{ active: resizing }"
        role="separator"
        aria-label="Resize mixer dock"
        @pointerdown="startResize"
      />
      <MixerConsole
        v-if="workspaceStore.mixerDockOpen"
        class="mixer-dock"
        density="dock"
        :style="workspaceStore.dockStyle"
      />
    </div>
    <MixerConsole v-show="workspaceStore.mode === 'mixer'" density="full" />
  </section>
</template>

<style scoped>
.studio-workspace{display:grid;grid-template-rows:34px minmax(0,1fr);min-width:0;min-height:0;background:var(--daw-workspace);overflow:hidden}.workspace-switcher{display:flex;align-items:center;gap:3px;padding:0 7px;border-bottom:1px solid var(--line-strong);background:var(--surface-1)}.workspace-switcher>span{flex:1}.workspace-switcher button{display:flex;align-items:center;gap:5px;height:25px;padding:0 8px;border:1px solid transparent;border-radius:4px;color:var(--text-muted);background:transparent;font-size:7px;cursor:pointer}.workspace-switcher button:hover{color:var(--text-primary);background:var(--daw-control-hover)}.workspace-switcher button.active{border-color:var(--line-strong);color:var(--text-primary);background:var(--surface-active);box-shadow:0 1px 0 #ffffff0a inset}.workspace-switcher button:focus-visible{outline:2px solid var(--focus);outline-offset:1px}.arrangement-mode{position:relative;display:flex;min-width:0;min-height:0;flex-direction:column}.arrangement-mode>:first-child{min-height:120px;flex:1}.mixer-dock{flex:none}.dock-resizer{position:relative;z-index:8;flex:none;height:5px;margin-top:-2px;border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line-soft);background:var(--daw-resizer);cursor:ns-resize}.dock-resizer::after{content:"";position:absolute;top:1px;left:50%;width:32px;height:1px;transform:translateX(-50%);background:var(--text-faint)}.dock-resizer.active{background:var(--surface-active)}
</style>

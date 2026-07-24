<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue"
import { useEventListener } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import ArrangementWorkspace from "../components/studio/ArrangementWorkspace.vue"
import StudioPlaceholderPanel from "../components/studio/StudioPlaceholderPanel.vue"
import StudioStatusbar from "../components/studio/StudioStatusbar.vue"
import StudioTopbar from "../components/studio/StudioTopbar.vue"
import { useEngineStore } from "../stores/engine"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useProjectStore } from "../stores/project"
import { useRecordingStore } from "../stores/recording"
import { useTransportStore } from "../stores/transport"
import { useArrangementViewStore } from "../stores/arrangementView"
import { useWaveformStore } from "../stores/waveform"

const router = useRouter()
const engineStore = useEngineStore()
const { nativeInfo } = storeToRefs(engineStore)
const audioRuntimeStore = useAudioRuntimeStore()
const {
  runtime: audioRuntime,
  statistics: audioStatistics,
  warnings: audioWarnings
} = storeToRefs(audioRuntimeStore)
const projectStore = useProjectStore()
const recordingStore = useRecordingStore()
const transportStore = useTransportStore()
const arrangementViewStore = useArrangementViewStore()
const waveformStore = useWaveformStore()
const { session } = storeToRefs(projectStore)
const {
  active: activeRecording,
  busy: recordingBusy,
  error: recordingError
} = storeToRefs(recordingStore)
const {
  playing,
  loading: playLoading,
  canPlay,
  playheadSeconds
} = storeToRefs(transportStore)

onMounted(() => {
  if (!session.value) void router.replace({ name: "welcome" })
  else void projectStore.refreshAssets()
  void engineStore.initialize()
})
async function openPreferences(): Promise<void> {
  if (activeRecording.value) await toggleRecording()
  if (activeRecording.value) return
  void router.push({ name: "preferences" })
}
async function openProjectSettings(): Promise<void> {
  if (activeRecording.value) await toggleRecording()
  if (activeRecording.value) return
  void router.push({ name: "project-settings" })
}
async function saveProject(): Promise<void> {
  if (activeRecording.value) await toggleRecording()
  if (activeRecording.value) return
  await projectStore.save()
}
async function closeProject(): Promise<void> {
  transportStore.stop()
  if (activeRecording.value) await recordingStore.toggle()
  if (activeRecording.value) return
  if (await projectStore.close()) {
    transportStore.reset()
    arrangementViewStore.reset()
    waveformStore.clear()
    void router.push({ name: "welcome" })
  }
}

async function toggleRecording(): Promise<void> {
  if (recordingBusy.value) return
  if (!activeRecording.value) transportStore.stop()
  const completed = await recordingStore.toggle()
  if (completed) transportStore.selectAndRevealClip(completed.id)
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
}

function handleShortcut(event: KeyboardEvent): void {
  if (isEditableTarget(event.target) || event.repeat) return
  if (event.code === "Space") {
    event.preventDefault()
    if (!activeRecording.value) void transportStore.toggle()
  } else if (event.code === "Home") {
    event.preventDefault()
    transportStore.goToStart()
  } else if (event.code === "KeyR") {
    event.preventDefault()
    void toggleRecording()
  }
}

useEventListener(window, "keydown", handleShortcut)
onBeforeUnmount(() => transportStore.stop())
</script>

<template>
  <main v-if="session" class="studio-shell">
    <StudioTopbar
      :native-info="nativeInfo"
      :engine-running="audioRuntime.state === 'running'"
      :project="session.configuration"
      :recording="Boolean(activeRecording)"
      :recording-busy="recordingBusy"
      :dirty="session.dirty"
      :playing="playing"
      :play-loading="playLoading"
      :can-play="canPlay && !activeRecording"
      :playhead-seconds="playheadSeconds"
      @open-preferences="openPreferences"
      @toggle-recording="toggleRecording"
      @toggle-playback="transportStore.toggle"
      @go-to-start="transportStore.goToStart"
      @save="saveProject"
      @close="closeProject"
      @open-project-settings="openProjectSettings"
    />
    <StudioPlaceholderPanel side="left" />
    <ArrangementWorkspace
      :recording-id="activeRecording?.id ?? null"
      :recording-started-at="activeRecording?.startedAt ?? null"
      :recording-error="recordingError"
    />
    <StudioPlaceholderPanel side="right" />
    <StudioStatusbar :runtime="audioRuntime" :statistics="audioStatistics" :audio-warnings="audioWarnings" />
  </main>
</template>

<style scoped>
.studio-shell{display:grid;grid-template:56px minmax(0,1fr) 25px/214px minmax(0,1fr) 258px;width:100vw;height:100vh;color:var(--text-primary);background:var(--canvas);-webkit-user-select:none;user-select:none}
.studio-shell :deep(:is(input,textarea,select,[contenteditable]:not([contenteditable="false"]))){-webkit-user-select:text;user-select:text}
@media(max-width:1100px){.studio-shell{grid-template-columns:184px minmax(0,1fr) 228px}}
</style>

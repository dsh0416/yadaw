<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue"
import { useEventListener } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import ChannelRoutingInspector from "../components/mixer/ChannelRoutingInspector.vue"
import StudioPlaceholderPanel from "../components/studio/StudioPlaceholderPanel.vue"
import StudioStatusbar from "../components/studio/StudioStatusbar.vue"
import StudioTopbar from "../components/studio/StudioTopbar.vue"
import StudioWorkspace from "../components/studio/StudioWorkspace.vue"
import { useEngineStore } from "../stores/engine"
import { useAudioRuntimeStore } from "../stores/audioRuntime"
import { useProjectStore } from "../stores/project"
import { useRecordingStore } from "../stores/recording"
import { useTransportStore } from "../stores/transport"
import { useMixerStore } from "../stores/mixer"
import { useStudioWorkspaceStore } from "../stores/studioWorkspace"
import { useStudioWorkflowStore } from "../stores/studioWorkflow"
import { useMidiImportStore } from "../stores/midiImport"
import MidiImportDialog from "../components/midi/MidiImportDialog.vue"
import { replaceTempoEventAtTick, secondsToTick } from "../utils/tempoMap"

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
const mixerStore = useMixerStore()
const workspaceStore = useStudioWorkspaceStore()
const studioWorkflowStore = useStudioWorkflowStore()
const midiImportStore = useMidiImportStore()
const { session } = storeToRefs(projectStore)
const {
  active: activeRecording,
  busy: recordingBusy,
  error: recordingError
} = storeToRefs(recordingStore)
const { playing, loading: playLoading, canPlay, playheadSeconds } = storeToRefs(transportStore)

onMounted(() => {
  if (!session.value) void router.replace({ name: "welcome" })
  else void projectStore.refreshAssets()
  void engineStore.initialize()
  void mixerStore.load()
  mixerStore.startMetering()
  transportStore.startPolling()
})
async function openPreferences(): Promise<void> {
  if (!(await studioWorkflowStore.prepareToLeaveStudio())) return
  void router.push({ name: "preferences" })
}
async function openProjectSettings(): Promise<void> {
  if (!(await studioWorkflowStore.prepareToLeaveStudio())) return
  await transportStore.stop()
  void router.push({ name: "project-settings" })
}
async function saveProject(): Promise<void> {
  await studioWorkflowStore.saveProject()
}
async function closeProject(): Promise<void> {
  if (await studioWorkflowStore.closeProject()) {
    void router.push({ name: "welcome" })
  }
}

function updateCurrentTempo(beatsPerMinute: number): void {
  const tempoMap = replaceTempoEventAtTick(
    mixerStore.graph.tempoMap,
    secondsToTick(mixerStore.graph.tempoMap, playheadSeconds.value),
    beatsPerMinute
  )
  void mixerStore.execute({ type: "replace-tempo-map", tempoMap })
}

async function toggleRecording(): Promise<void> {
  if (recordingBusy.value) return
  const completed = await studioWorkflowStore.toggleRecording()
  if (completed) transportStore.selectAndRevealClip(completed.id)
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
}

function handleShortcut(event: KeyboardEvent): void {
  if (isEditableTarget(event.target) || event.repeat) return
  if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
    event.preventDefault()
    if (event.shiftKey) void mixerStore.redo()
    else void mixerStore.undo()
    return
  }
  if ((event.code === "Delete" || event.code === "Backspace") && transportStore.selectedClipId) {
    event.preventDefault()
    const clipId = transportStore.selectedClipId
    void mixerStore.execute({ type: "delete-clip", clipId }).then((deleted) => {
      if (deleted) transportStore.clearSelection()
    })
    return
  }
  if (event.code === "Space") {
    event.preventDefault()
    if (!activeRecording.value) void transportStore.toggle()
  } else if (event.code === "Home") {
    event.preventDefault()
    void transportStore.goToStart()
  } else if (event.code === "KeyR") {
    event.preventDefault()
    void toggleRecording()
  } else if (event.code === "KeyM") {
    event.preventDefault()
    if (workspaceStore.mode === "mixer") workspaceStore.showArrangement()
    else workspaceStore.showMixer()
  }
}

useEventListener(window, "keydown", handleShortcut)
onBeforeUnmount(() => {
  transportStore.stopPolling()
  mixerStore.stopMetering()
})
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
      :tempo-map="mixerStore.graph.tempoMap"
      @open-preferences="openPreferences"
      @toggle-recording="toggleRecording"
      @toggle-playback="transportStore.toggle"
      @go-to-start="transportStore.goToStart"
      @save="saveProject"
      @close="closeProject"
      @open-project-settings="openProjectSettings"
      @import-midi="midiImportStore.prepare()"
      @update-tempo="updateCurrentTempo"
    />
    <StudioPlaceholderPanel side="left" />
    <StudioWorkspace
      :recording-id="activeRecording?.id ?? null"
      :recording-started-at="activeRecording?.startedAt ?? null"
      :recording-start-frame="activeRecording?.startFrame ?? null"
      :recording-error="recordingError"
    />
    <ChannelRoutingInspector />
    <StudioStatusbar
      :runtime="audioRuntime"
      :statistics="audioStatistics"
      :audio-warnings="audioWarnings"
    />
    <MidiImportDialog />
  </main>
</template>

<style scoped>
.studio-shell {
  display: grid;
  grid-template: 56px minmax(0, 1fr) 25px/214px minmax(0, 1fr) 258px;
  width: 100vw;
  height: 100vh;
  color: var(--text-primary);
  background: var(--canvas);
  -webkit-user-select: none;
  user-select: none;
}
.studio-shell
  :deep(:is(input, textarea, select, [contenteditable]:not([contenteditable="false"]))) {
  -webkit-user-select: text;
  user-select: text;
}
@media (max-width: 1100px) {
  .studio-shell {
    grid-template-columns: 184px minmax(0, 1fr) 228px;
  }
}
</style>

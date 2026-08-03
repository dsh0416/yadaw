<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from "vue"
import { useEventListener } from "@vueuse/core"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import type {
  KeySignatureMode,
  MixerChannelMeter,
  MixerChannelPatch,
  MixerParameterPreview,
  TimeSignatureEventState
} from "@yadaw/contracts"
import SoundBrowser from "../components/studio/SoundBrowser.vue"
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
import { usePianoRollStore } from "../stores/pianoRoll"
import MidiImportDialog from "../components/midi/MidiImportDialog.vue"
import NotesPanel from "../components/notes/NotesPanel.vue"
import {
  replaceTempoEventAtTick,
  replaceTimeSignatureEventAtTick,
  secondsToTick
} from "../utils/tempoMap"
import { replaceKeySignatureEventAtTick } from "../utils/keySignatures"
import { defaultCycleRange } from "../utils/cycleRange"

const router = useRouter()
const engineStore = useEngineStore()
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
const pianoRollStore = usePianoRollStore()
const { session, projectAssets } = storeToRefs(projectStore)
const {
  active: activeRecording,
  busy: recordingBusy,
  error: recordingError
} = storeToRefs(recordingStore)
const {
  playing,
  loading: playLoading,
  canPlay,
  countInEnabled,
  playheadSeconds,
  loopEnabled,
  loopRange
} = storeToRefs(transportStore)
const EMPTY_MASTER_METER: MixerChannelMeter = {
  channelId: "master",
  preFaderPeak: [0, 0],
  postFaderPeak: [0, 0],
  heldPeak: [0, 0],
  clipped: false
}
const masterMeter = computed(() =>
  mixerStore.master ? mixerStore.meterFor(mixerStore.master.id) : EMPTY_MASTER_METER
)

onMounted(() => {
  if (!session.value) void router.replace({ name: "welcome" })
  void engineStore.initialize()
  mixerStore.startMetering()
  transportStore.startPolling()
})
function updateCurrentTempo(beatsPerMinute: number): void {
  const tempoMap = replaceTempoEventAtTick(
    mixerStore.graph.tempoMap,
    secondsToTick(mixerStore.graph.tempoMap, playheadSeconds.value),
    beatsPerMinute
  )
  void mixerStore.execute({ type: "replace-tempo-map", tempoMap })
}

function updateCurrentMeter(
  signature: Pick<TimeSignatureEventState, "numerator" | "denominator">
): void {
  const tempoMap = replaceTimeSignatureEventAtTick(
    mixerStore.graph.tempoMap,
    secondsToTick(mixerStore.graph.tempoMap, playheadSeconds.value),
    signature
  )
  void mixerStore.execute({ type: "replace-tempo-map", tempoMap })
}

function updateCurrentKey(signature: { fifths: number; mode: KeySignatureMode }): void {
  const events = replaceKeySignatureEventAtTick(
    mixerStore.graph.keySignatureEvents,
    secondsToTick(mixerStore.graph.tempoMap, playheadSeconds.value),
    signature
  )
  void mixerStore.execute({ type: "replace-key-signature-map", events })
}

function previewMaster(preview: MixerParameterPreview): void {
  mixerStore.preview(preview)
}

function updateMaster(channelId: string, patch: MixerChannelPatch): void {
  void mixerStore.updateChannel(channelId, patch)
}

function toggleMetronome(): void {
  void mixerStore.toggleMetronome()
}

async function toggleRecording(): Promise<void> {
  if (recordingBusy.value) return
  const completed = await studioWorkflowStore.toggleRecording()
  if (completed) transportStore.selectAndRevealClip(completed.id)
}

function toggleCycle(): void {
  if (transportStore.snapshot.clockSource === "external") return
  const range =
    loopRange.value ??
    defaultCycleRange(
      mixerStore.graph.tempoMap,
      secondsToTick(mixerStore.graph.tempoMap, playheadSeconds.value)
    )
  void transportStore.setLoop(!loopEnabled.value || loopRange.value === null, range)
}

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  )
}

function handleShortcut(event: KeyboardEvent): void {
  if (isEditableTarget(event.target) || event.repeat) return
  if (
    (event.code === "Delete" || event.code === "Backspace") &&
    pianoRollStore.arrangementClipIds.length > 0 &&
    !pianoRollStore.editorFocused
  ) {
    event.preventDefault()
    const commands = pianoRollStore.arrangementClipIds.map((clipId) => ({
      type: "delete-midi-clip" as const,
      clipId
    }))
    void mixerStore
      .execute(commands.length === 1 ? commands[0]! : { type: "batch", commands })
      .then((deleted) => {
        if (deleted) pianoRollStore.clearArrangementSelection()
      })
    return
  }
  if ((event.code === "Delete" || event.code === "Backspace") && transportStore.selectedClipId) {
    event.preventDefault()
    const clipId = transportStore.selectedClipId
    void mixerStore.execute({ type: "delete-audio-clip", clipId }).then((deleted) => {
      if (deleted) transportStore.clearSelection()
    })
    return
  }
}

useEventListener(window, "keydown", handleShortcut)
onBeforeUnmount(() => {
  transportStore.stopPolling()
  mixerStore.stopMetering()
})
</script>

<template>
  <main
    v-if="session"
    :class="[
      'studio-shell',
      {
        'sound-browser-open': workspaceStore.soundBrowserOpen,
        'notes-panel-open': workspaceStore.notesPanelOpen
      }
    ]"
  >
    <StudioTopbar
      :engine-running="audioRuntime.state === 'running'"
      :recording="Boolean(activeRecording)"
      :recording-busy="recordingBusy"
      :playing="playing"
      :play-loading="playLoading"
      :can-play="canPlay && !activeRecording"
      :count-in-enabled="countInEnabled"
      :cycle-enabled="loopEnabled"
      :external-clock="transportStore.snapshot.clockSource === 'external'"
      :playhead-seconds="playheadSeconds"
      :tempo-map="mixerStore.graph.tempoMap"
      :key-signature-events="mixerStore.graph.keySignatureEvents"
      :sound-browser-open="workspaceStore.soundBrowserOpen"
      :notes-panel-open="workspaceStore.notesPanelOpen"
      :mixer-dock-open="workspaceStore.mixerDockOpen"
      :piano-roll-dock-open="workspaceStore.pianoRollDockOpen"
      :piano-roll-available="pianoRollStore.openClipIds.length > 0"
      :metronome-channel="mixerStore.metronome"
      :master-channel="mixerStore.master"
      :master-meter="masterMeter"
      @toggle-sound-browser="workspaceStore.toggleSoundBrowser"
      @toggle-notes-panel="workspaceStore.toggleNotesPanel"
      @toggle-mixer-dock="workspaceStore.toggleMixerDock"
      @toggle-piano-roll-dock="workspaceStore.togglePianoRollDock"
      @toggle-recording="toggleRecording"
      @toggle-playback="transportStore.toggle"
      @go-to-start="transportStore.goToStart"
      @toggle-count-in="transportStore.toggleCountIn"
      @toggle-cycle="toggleCycle"
      @update-tempo="updateCurrentTempo"
      @update-meter="updateCurrentMeter"
      @update-key="updateCurrentKey"
      @toggle-metronome="toggleMetronome"
      @preview-master="previewMaster"
      @update-master="updateMaster"
    />
    <SoundBrowser v-show="workspaceStore.soundBrowserOpen" :assets="projectAssets" />
    <StudioWorkspace
      :recording-id="activeRecording?.id ?? null"
      :recording-started-at="activeRecording?.startedAt ?? null"
      :recording-start-frame="activeRecording?.startFrame ?? null"
      :recording-start-tick="activeRecording?.startTick ?? null"
      :recording-audio-track-ids="activeRecording?.audioTrackIds ?? []"
      :recording-midi-track-ids="activeRecording?.midiTrackIds ?? []"
      :recording-error="recordingError"
    />
    <NotesPanel v-show="workspaceStore.notesPanelOpen" />
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
  grid-template: 56px minmax(0, 1fr) 25px / minmax(0, 1fr);
  width: 100%;
  height: 100%;
  color: var(--text-primary);
  background: var(--canvas);
  -webkit-user-select: none;
  user-select: none;
}
.studio-shell.sound-browser-open {
  grid-template-columns: 214px minmax(0, 1fr);
}
.studio-shell.notes-panel-open {
  grid-template-columns: minmax(0, 1fr) 292px;
}
.studio-shell.sound-browser-open.notes-panel-open {
  grid-template-columns: 214px minmax(0, 1fr) 292px;
}
.studio-shell
  :deep(:is(input, textarea, select, [contenteditable]:not([contenteditable="false"]))) {
  -webkit-user-select: text;
  user-select: text;
}
@media (max-width: 1100px) {
  .studio-shell.sound-browser-open {
    grid-template-columns: 184px minmax(0, 1fr);
  }
  .studio-shell.notes-panel-open {
    grid-template-columns: minmax(0, 1fr) 264px;
  }
  .studio-shell.sound-browser-open.notes-panel-open {
    grid-template-columns: 184px minmax(0, 1fr) 264px;
  }
}
</style>

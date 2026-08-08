<script setup lang="ts">
import { useI18n } from "vue-i18n"
import {
  AudioLines,
  BellRing,
  CircleHelp,
  Download,
  Gauge,
  Library,
  List,
  ListMusic,
  NotebookTabs,
  PanelBottom,
  Pencil,
  SlidersHorizontal,
  Zap
} from "@lucide/vue"
import type {
  KeySignatureEventState,
  KeySignatureMode,
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  TempoMapSnapshot,
  TimeSignatureEventState
} from "@heron/contracts"
import StudioControlButton from "./topbar/StudioControlButton.vue"
import StudioMasterControl from "./topbar/StudioMasterControl.vue"
import StudioMusicalDisplay from "./topbar/StudioMusicalDisplay.vue"
import StudioTransportControls from "./topbar/StudioTransportControls.vue"

defineProps<{
  engineRunning: boolean
  recording: boolean
  recordingBusy: boolean
  playing: boolean
  playLoading: boolean
  canPlay: boolean
  countInEnabled: boolean
  cycleEnabled: boolean
  externalClock: boolean
  playheadSeconds: number
  tempoMap: TempoMapSnapshot
  keySignatureEvents: KeySignatureEventState[]
  soundBrowserOpen: boolean
  inspectorOpen: boolean
  notesPanelOpen: boolean
  mixerDockOpen: boolean
  pianoRollDockOpen: boolean
  pianoRollAvailable: boolean
  metronomeChannel: MixerChannelState | null
  masterChannel: MixerChannelState | null
  masterMeter?: MixerChannelMeter
  lowLatencyModeEnabled?: boolean
  lowLatencyModeBusy?: boolean
  lowLatencyModeDisabled?: boolean
  lowLatencyModeTooltip?: string
}>()
const emit = defineEmits<{
  toggleSoundBrowser: []
  toggleInspector: []
  toggleNotesPanel: []
  toggleMixerDock: []
  togglePianoRollDock: []
  toggleRecording: []
  togglePlayback: []
  goToStart: []
  toggleCountIn: []
  toggleCycle: []
  updateTempo: [beatsPerMinute: number]
  updateMeter: [signature: Pick<TimeSignatureEventState, "numerator" | "denominator">]
  updateKey: [signature: { fifths: number; mode: KeySignatureMode }]
  toggleMetronome: []
  previewMaster: [preview: MixerParameterPreview]
  updateMaster: [channelId: string, patch: MixerChannelPatch]
  toggleLowLatencyMode: []
}>()

const { t } = useI18n()
</script>

<template>
  <header class="topbar">
    <div class="control-group left-panel-group" data-topbar-group="left-panel">
      <StudioControlButton
        :label="t('studio.topbar.library')"
        :pressed="soundBrowserOpen"
        tone="accent"
        @activate="emit('toggleSoundBrowser')"
      >
        <Library :size="15" />
      </StudioControlButton>
      <StudioControlButton
        :label="t('studio.topbar.inspector')"
        :pressed="inspectorOpen"
        tone="accent"
        compact-hidden
        @activate="emit('toggleInspector')"
      >
        <SlidersHorizontal :size="15" />
      </StudioControlButton>
      <StudioControlButton :label="t('studio.topbar.quickHelp')" unavailable compact-hidden>
        <CircleHelp :size="15" />
      </StudioControlButton>
      <StudioControlButton :label="t('studio.topbar.downloadManager')" unavailable compact-hidden>
        <Download :size="15" />
      </StudioControlButton>
    </div>

    <div class="control-group bottom-panel-group" data-topbar-group="bottom-panel">
      <StudioControlButton :label="t('studio.topbar.smartControls')" unavailable compact-hidden>
        <Gauge :size="15" />
      </StudioControlButton>
      <StudioControlButton
        :label="t('studio.topbar.mixer')"
        :pressed="mixerDockOpen"
        tone="accent"
        @activate="emit('toggleMixerDock')"
      >
        <PanelBottom :size="15" />
      </StudioControlButton>
      <StudioControlButton
        :label="t('studio.topbar.pianoRoll')"
        :pressed="pianoRollDockOpen"
        :disabled="!pianoRollAvailable"
        tone="accent"
        @activate="emit('togglePianoRollDock')"
      >
        <Pencil :size="15" />
      </StudioControlButton>
    </div>

    <div class="control-group transport-group" data-topbar-group="transport">
      <StudioTransportControls
        :engine-running="engineRunning"
        :recording="recording"
        :recording-busy="recordingBusy"
        :playing="playing"
        :play-loading="playLoading"
        :can-play="canPlay"
        :cycle-enabled="cycleEnabled"
        :external-clock="externalClock"
        @go-to-start="emit('goToStart')"
        @toggle-playback="emit('togglePlayback')"
        @toggle-recording="emit('toggleRecording')"
        @toggle-cycle="emit('toggleCycle')"
      />
    </div>

    <StudioMusicalDisplay
      data-topbar-group="musical-display"
      :playhead-seconds="playheadSeconds"
      :tempo-map="tempoMap"
      :key-signature-events="keySignatureEvents"
      @update-tempo="emit('updateTempo', $event)"
      @update-meter="emit('updateMeter', $event)"
      @update-key="emit('updateKey', $event)"
    />

    <div class="control-group tools-group" data-topbar-group="tools">
      <StudioControlButton
        :label="t('studio.topbar.lowLatencyMode')"
        :tooltip="lowLatencyModeTooltip"
        :pressed="lowLatencyModeEnabled"
        :disabled="lowLatencyModeDisabled || lowLatencyModeBusy"
        tone="success"
        @activate="emit('toggleLowLatencyMode')"
      >
        <Zap :size="15" />
      </StudioControlButton>
      <StudioControlButton :label="t('studio.topbar.varispeed')" unavailable compact-hidden>
        <Gauge :size="15" />
      </StudioControlButton>
      <StudioControlButton :label="t('studio.topbar.tuner')" unavailable compact-hidden>
        <AudioLines :size="15" />
      </StudioControlButton>
      <StudioControlButton :label="t('studio.topbar.solo')" unavailable compact-hidden>
        <span class="letter-control">S</span>
      </StudioControlButton>
    </div>

    <div class="control-group metronome-group" data-topbar-group="metronome">
      <StudioControlButton
        :label="t('studio.topbar.countIn')"
        :pressed="countInEnabled"
        compact-hidden
        tone="accent"
        @activate="emit('toggleCountIn')"
      >
        <span class="count-in-control">1234</span>
      </StudioControlButton>
      <StudioControlButton
        :label="t('studio.topbar.metronome')"
        :pressed="metronomeChannel ? !metronomeChannel.muted : false"
        :disabled="metronomeChannel === null"
        tone="accent"
        @activate="emit('toggleMetronome')"
      >
        <BellRing :size="15" />
      </StudioControlButton>
    </div>

    <StudioMasterControl
      data-topbar-group="master"
      :channel="masterChannel"
      :meter="masterMeter"
      @preview="emit('previewMaster', $event)"
      @update-channel="(channelId, patch) => emit('updateMaster', channelId, patch)"
    />

    <div class="control-group right-panel-group" data-topbar-group="right-panel">
      <StudioControlButton :label="t('studio.topbar.listEditors')" unavailable compact-hidden>
        <List :size="15" />
      </StudioControlButton>
      <StudioControlButton
        :label="t('studio.topbar.notes')"
        :pressed="notesPanelOpen"
        tone="accent"
        @activate="emit('toggleNotesPanel')"
      >
        <NotebookTabs :size="15" />
      </StudioControlButton>
      <StudioControlButton :label="t('studio.topbar.loopBrowser')" unavailable compact-hidden>
        <ListMusic :size="15" />
      </StudioControlButton>
      <StudioControlButton :label="t('studio.topbar.mediaBrowser')" unavailable compact-hidden>
        <Library :size="15" />
      </StudioControlButton>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  grid-column: 1/-1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  height: 56px;
  gap: clamp(4px, 0.55vw, 10px);
  padding: 5px 12px;
  border-bottom: 1px solid var(--line-strong);
  background: color-mix(in srgb, var(--surface-1) 96%, transparent);
  box-shadow:
    0 1px 0 var(--ui-domain-color-ffffff05) inset,
    0 8px 22px var(--shadow);
}
.control-group {
  display: flex;
  align-items: center;
  flex: none;
  gap: 1px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--line-strong) 72%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--daw-control) 78%, transparent);
  box-shadow: 0 1px 0 var(--ui-domain-color-ffffff05) inset;
}
.letter-control,
.count-in-control {
  font: var(--ui-type-weight-bold) var(--ui-type-size-body-compact) var(--ui-type-family-data);
}
.count-in-control {
  font-size: var(--ui-type-size-caption);
  letter-spacing: var(--ui-type-tracking-tighter);
}
@media (max-width: 1279px) {
  .topbar {
    gap: 5px;
    padding-right: 8px;
    padding-left: 8px;
  }
  .placeholder-only {
    display: none;
  }
  .control-group {
    padding: 1px;
  }
}
</style>

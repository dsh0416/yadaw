<script setup lang="ts">
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
  ShieldX,
  SlidersHorizontal
} from "@lucide/vue"
import type {
  MixerChannelMeter,
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  TempoMapSnapshot
} from "@yadaw/contracts"
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
  playheadSeconds: number
  tempoMap: TempoMapSnapshot
  soundBrowserOpen: boolean
  mixerDockOpen: boolean
  masterChannel: MixerChannelState | null
  masterMeter: MixerChannelMeter
}>()
const emit = defineEmits<{
  toggleSoundBrowser: []
  toggleMixerDock: []
  toggleRecording: []
  togglePlayback: []
  goToStart: []
  updateTempo: [beatsPerMinute: number]
  previewMaster: [preview: MixerParameterPreview]
  updateMaster: [channelId: string, patch: MixerChannelPatch]
}>()
</script>

<template>
  <header class="topbar">
    <div class="control-group left-panel-group" data-topbar-group="left-panel">
      <StudioControlButton
        label="Library"
        :pressed="soundBrowserOpen"
        tone="accent"
        @activate="emit('toggleSoundBrowser')"
      >
        <Library :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Inspector" unavailable compact-hidden>
        <SlidersHorizontal :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Quick Help" unavailable compact-hidden>
        <CircleHelp :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Download Manager" unavailable compact-hidden>
        <Download :size="15" />
      </StudioControlButton>
    </div>

    <div class="control-group bottom-panel-group" data-topbar-group="bottom-panel">
      <StudioControlButton label="Smart Controls" unavailable compact-hidden>
        <Gauge :size="15" />
      </StudioControlButton>
      <StudioControlButton
        label="Mixer"
        :pressed="mixerDockOpen"
        tone="accent"
        @activate="emit('toggleMixerDock')"
      >
        <PanelBottom :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Editors" unavailable compact-hidden>
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
        @go-to-start="emit('goToStart')"
        @toggle-playback="emit('togglePlayback')"
        @toggle-recording="emit('toggleRecording')"
      />
    </div>

    <StudioMusicalDisplay
      data-topbar-group="musical-display"
      :playhead-seconds="playheadSeconds"
      :tempo-map="tempoMap"
      @update-tempo="emit('updateTempo', $event)"
    />

    <div class="control-group placeholder-only tools-group" data-topbar-group="tools">
      <StudioControlButton label="Low Latency Mode" unavailable>
        <ShieldX :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Varispeed" unavailable>
        <Gauge :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Tuner" unavailable>
        <AudioLines :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Solo" unavailable>
        <span class="letter-control">S</span>
      </StudioControlButton>
    </div>

    <div class="control-group placeholder-only metronome-group" data-topbar-group="metronome">
      <StudioControlButton label="Count-in" unavailable tone="accent">
        <span class="count-in-control">1234</span>
      </StudioControlButton>
      <StudioControlButton label="Metronome" unavailable tone="accent">
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

    <div class="control-group placeholder-only right-panel-group" data-topbar-group="right-panel">
      <StudioControlButton label="List Editors" unavailable>
        <List :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Notes" unavailable>
        <NotebookTabs :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Loop Browser" unavailable>
        <ListMusic :size="15" />
      </StudioControlButton>
      <StudioControlButton label="Media Browser" unavailable>
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
  -webkit-app-region: drag;
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
  font: 700 9px var(--font-utility);
}
.count-in-control {
  font-size: 7px;
  letter-spacing: -0.08em;
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

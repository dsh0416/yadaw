<script setup lang="ts">
import { computed, nextTick, shallowRef, useTemplateRef } from "vue"
import {
  Circle,
  FileMusic,
  LoaderCircle,
  LogOut,
  Pause,
  Play,
  Save,
  Settings,
  SkipBack,
  SlidersHorizontal
} from "@lucide/vue"
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui"
import type { NativeEngineInfo, ProjectConfiguration, TempoMapSnapshot } from "@yadaw/contracts"
import {
  musicalPositionAtTick,
  secondsToTick,
  tempoAtTick,
  timeSignatureAtTick
} from "../../utils/tempoMap"

const props = defineProps<{
  nativeInfo?: NativeEngineInfo
  engineRunning: boolean
  project: ProjectConfiguration
  recording: boolean
  recordingBusy: boolean
  dirty: boolean
  playing: boolean
  playLoading: boolean
  canPlay: boolean
  playheadSeconds: number
  tempoMap: TempoMapSnapshot
}>()
const emit = defineEmits<{
  openPreferences: []
  toggleRecording: []
  togglePlayback: []
  goToStart: []
  save: []
  close: []
  openProjectSettings: []
  importMidi: []
  updateTempo: [beatsPerMinute: number]
}>()

const MINIMUM_TEMPO = 20
const MAXIMUM_TEMPO = 300
const editingTempo = shallowRef(false)
const tempoDraft = shallowRef("")
const tempoInput = useTemplateRef<HTMLInputElement>("tempoInput")
const musicalPosition = computed(() => {
  const position = musicalPositionAtTick(props.tempoMap, playheadTick.value)
  return `${String(position.bar).padStart(3, "0")}·${String(position.beat).padStart(2, "0")}·${String(position.tick).padStart(3, "0")}`
})
const playheadTick = computed(() => secondsToTick(props.tempoMap, props.playheadSeconds))
const currentTempo = computed(() => tempoAtTick(props.tempoMap, playheadTick.value))
const currentSignature = computed(() => timeSignatureAtTick(props.tempoMap, playheadTick.value))

function beginTempoEdit(): void {
  if (editingTempo.value) return
  tempoDraft.value = currentTempo.value.toFixed(2)
  editingTempo.value = true
  void nextTick(() => tempoInput.value?.select())
}

function cancelTempoEdit(): void {
  editingTempo.value = false
}

function commitTempoEdit(): void {
  if (!editingTempo.value) return
  const parsed = Number(tempoDraft.value)
  editingTempo.value = false
  if (!Number.isFinite(parsed)) return
  const normalized =
    Math.round(Math.min(MAXIMUM_TEMPO, Math.max(MINIMUM_TEMPO, parsed)) * 100) / 100
  if (normalized !== currentTempo.value) emit("updateTempo", normalized)
}
</script>

<template>
  <header class="topbar">
    <div class="brand-lockup">
      <div class="brand-mark" aria-hidden="true"><span /><span /><span /></div>
      <div class="brand-copy">
        <strong>YADAW</strong><span>{{ project.name }}{{ dirty ? " · Unsaved" : "" }}</span>
      </div>
    </div>

    <div class="transport" aria-label="Transport controls">
      <div class="transport-buttons">
        <TooltipRoot>
          <TooltipTrigger as-child
            ><button aria-label="Go to start" @click="emit('goToStart')">
              <SkipBack :size="15" /></button
          ></TooltipTrigger>
          <TooltipPortal
            ><TooltipContent class="tooltip-content" :side-offset="9"
              >Go to start <span>Home</span><TooltipArrow class="tooltip-arrow" /></TooltipContent
          ></TooltipPortal>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as-child>
            <button
              :aria-label="playing ? 'Pause' : 'Play'"
              :class="['play', { active: playing }]"
              :disabled="!canPlay && !playing && !playLoading"
              @click="emit('togglePlayback')"
            >
              <LoaderCircle v-if="playLoading" :size="15" class="spin" />
              <Pause v-else-if="playing" :size="15" fill="currentColor" />
              <Play v-else :size="15" fill="currentColor" />
            </button>
          </TooltipTrigger>
          <TooltipPortal
            ><TooltipContent class="tooltip-content" :side-offset="9"
              >{{ playing ? "Pause" : "Play" }} <span>Space</span
              ><TooltipArrow class="tooltip-arrow" /></TooltipContent
          ></TooltipPortal>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as-child
            ><button
              aria-label="Record"
              :class="['record', { active: recording }]"
              :disabled="(!engineRunning && !recording) || recordingBusy"
              @click="emit('toggleRecording')"
            >
              <Circle :size="12" fill="currentColor" /></button
          ></TooltipTrigger>
          <TooltipPortal
            ><TooltipContent class="tooltip-content" :side-offset="9"
              >Record <span>R</span><TooltipArrow class="tooltip-arrow" /></TooltipContent
          ></TooltipPortal>
        </TooltipRoot>
      </div>
      <div class="time-display">
        <span>BAR · BEAT · TICK</span><strong>{{ musicalPosition }}</strong>
      </div>
      <div class="tempo-display">
        <div class="tempo-field">
          <input
            v-if="editingTempo"
            ref="tempoInput"
            v-model="tempoDraft"
            class="tempo-input"
            aria-label="Edit current tempo"
            type="number"
            :min="MINIMUM_TEMPO"
            :max="MAXIMUM_TEMPO"
            step="0.01"
            @blur="commitTempoEdit"
            @keydown.enter.prevent="commitTempoEdit"
            @keydown.escape.prevent="cancelTempoEdit"
          />
          <button
            v-else
            type="button"
            class="tempo-value"
            :aria-label="`Tempo ${currentTempo.toFixed(2)} BPM; double-click to edit`"
            title="Double-click to edit the current Tempo Track event"
            @dblclick="beginTempoEdit"
            @keydown.enter.prevent="beginTempoEdit"
          >
            {{ currentTempo.toFixed(2) }}
          </button>
          <span>BPM</span>
        </div>
        <div class="tempo-field">
          <b>{{ currentSignature.numerator }} / {{ currentSignature.denominator }}</b
          ><span>METER</span>
        </div>
      </div>
    </div>

    <div class="top-actions">
      <div class="engine-badge">
        <span :class="['status-dot', { ready: nativeInfo && engineRunning }]" />
        <span class="engine-copy"
          ><b>{{ engineRunning ? "Engine online" : "Engine standby" }}</b
          ><small>{{
            nativeInfo
              ? `${nativeInfo.backend} · N-API ${nativeInfo.nodeApi}`
              : "Connecting native core"
          }}</small></span
        >
      </div>
      <button class="preferences-button" aria-label="Import MIDI file" @click="emit('importMidi')">
        <FileMusic :size="15" />
      </button>
      <button
        class="preferences-button"
        aria-label="Project settings"
        @click="emit('openProjectSettings')"
      >
        <SlidersHorizontal :size="15" />
      </button>
      <button
        class="preferences-button"
        aria-label="Save project"
        :disabled="!dirty"
        @click="emit('save')"
      >
        <Save :size="15" />
      </button>
      <button class="preferences-button" aria-label="Close project" @click="emit('close')">
        <LogOut :size="15" />
      </button>
      <TooltipRoot>
        <TooltipTrigger as-child
          ><button
            class="preferences-button"
            aria-label="Open preferences"
            @click="emit('openPreferences')"
          >
            <Settings :size="16" /></button
        ></TooltipTrigger>
        <TooltipPortal
          ><TooltipContent class="tooltip-content" :side-offset="9"
            >Preferences <span>Ctrl+,</span><TooltipArrow class="tooltip-arrow" /></TooltipContent
        ></TooltipPortal>
      </TooltipRoot>
    </div>
  </header>
</template>

<style scoped>
.topbar {
  grid-column: 1/-1;
  display: grid;
  grid-template-columns: minmax(210px, 1fr) auto minmax(260px, 1fr);
  align-items: center;
  min-width: 0;
  padding: 8px 14px;
  border-bottom: 1px solid var(--line-strong);
  background: color-mix(in srgb, var(--surface-1) 94%, transparent);
  box-shadow:
    0 1px 0 #ffffff05 inset,
    0 10px 28px var(--shadow);
  -webkit-app-region: drag;
}
.topbar button,
.topbar input {
  -webkit-app-region: no-drag;
}
.brand-lockup,
.top-actions,
.engine-badge,
.engine-copy,
.transport,
.transport-buttons,
.tempo-display {
  display: flex;
  align-items: center;
}
.brand-lockup {
  min-width: 0;
  gap: 11px;
}
.brand-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 35px;
  height: 35px;
  gap: 3px;
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  border-radius: 9px;
  background: linear-gradient(145deg, var(--surface-3), var(--surface-1));
  box-shadow:
    0 0 0 1px #ffffff08 inset,
    0 8px 20px var(--shadow);
}
.brand-mark span {
  width: 3px;
  border-radius: 2px;
  background: linear-gradient(var(--accent-soft), var(--signal-cyan));
  box-shadow: 0 0 7px color-mix(in srgb, var(--accent) 40%, transparent);
}
.brand-mark span:nth-child(1) {
  height: 10px;
}
.brand-mark span:nth-child(2) {
  height: 21px;
}
.brand-mark span:nth-child(3) {
  height: 15px;
}
.brand-copy strong,
.brand-copy span,
.engine-copy b,
.engine-copy small {
  display: block;
}
.brand-copy strong {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.2em;
}
.brand-copy span {
  margin-top: 3px;
  color: var(--text-muted);
  font-size: 10px;
}
.transport {
  justify-self: center;
  border: 1px solid var(--line-strong);
  border-radius: 10px;
  background: var(--surface-sunken);
  box-shadow:
    0 1px 0 #ffffff08 inset,
    0 8px 24px var(--shadow);
  overflow: hidden;
}
.transport-buttons {
  gap: 3px;
  padding: 4px;
}
.transport-buttons button,
.preferences-button {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
}
.transport-buttons button:hover,
.preferences-button:hover {
  border-color: var(--line-strong);
  color: var(--text-primary);
  background: var(--surface-3);
}
.transport-buttons button:focus-visible,
.preferences-button:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
.transport-buttons button:disabled {
  cursor: not-allowed;
  opacity: 0.7;
}
.transport-buttons .play {
  color: var(--signal-cyan);
}
.transport-buttons .record {
  color: var(--record);
}
.time-display {
  display: grid;
  align-self: stretch;
  align-content: center;
  min-width: 136px;
  padding: 0 16px;
  border-right: 1px solid var(--line-soft);
  border-left: 1px solid var(--line-soft);
}
.time-display span {
  color: var(--text-faint);
  font: 700 7px var(--font-utility);
  letter-spacing: 0.15em;
}
.time-display strong {
  margin-top: 2px;
  color: var(--text-primary);
  font: 500 13px var(--font-utility);
  letter-spacing: 0.08em;
  text-shadow: 0 0 16px color-mix(in srgb, var(--signal-cyan) 27%, transparent);
}
.tempo-display {
  gap: 13px;
  padding: 0 12px;
  color: var(--text-muted);
  font: 7px var(--font-utility);
  letter-spacing: 0.06em;
}
.tempo-field {
  display: grid;
  align-content: center;
  min-width: 42px;
}
.tempo-field span,
.tempo-field b {
  display: block;
}
.tempo-field b,
.tempo-value,
.tempo-input {
  height: 14px;
  margin: 0 0 2px;
  color: var(--text-secondary);
  font: 500 9px var(--font-utility);
}
.tempo-value {
  min-width: 42px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: text;
}
.tempo-value:hover {
  color: var(--text-primary);
}
.tempo-value:focus-visible {
  border-radius: 2px;
  outline: 1px solid var(--focus);
  outline-offset: 2px;
}
.tempo-input {
  width: 50px;
  padding: 0 3px;
  border: 1px solid var(--focus);
  border-radius: 3px;
  background: var(--surface-1);
  outline: none;
}
.top-actions {
  justify-self: end;
  min-width: 0;
  gap: 8px;
}
.engine-badge {
  min-width: 0;
  gap: 8px;
  margin-right: 4px;
}
.status-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--warning);
  box-shadow: 0 0 9px var(--warning);
}
.status-dot.ready {
  background: var(--signal-cyan);
  box-shadow: 0 0 9px var(--signal-cyan);
}
.engine-copy {
  min-width: 0;
  align-items: flex-start;
  flex-direction: column;
}
.engine-copy b {
  color: var(--text-secondary);
  font-size: 9px;
  font-weight: 650;
}
.engine-copy small {
  margin-top: 2px;
  color: var(--text-faint);
  font: 7px var(--font-utility);
  white-space: nowrap;
}
@media (max-width: 1160px) {
  .topbar {
    grid-template-columns: 180px 1fr auto;
  }
  .tempo-display,
  .engine-copy {
    display: none;
  }
}
.transport-buttons .record.active {
  color: #fff;
  background: var(--record);
  box-shadow: 0 0 16px color-mix(in srgb, var(--record) 60%, transparent);
}
.preferences-button:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}
.transport-buttons .play.active {
  color: #081116;
  background: var(--signal-cyan);
  box-shadow: 0 0 14px color-mix(in srgb, var(--signal-cyan) 40%, transparent);
}
.spin {
  animation: spin 800ms linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}
@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}
</style>

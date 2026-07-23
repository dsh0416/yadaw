<script setup lang="ts">
import { computed } from "vue"
import { Circle, LoaderCircle, LogOut, Pause, Play, Save, Settings, SkipBack, SlidersHorizontal } from "@lucide/vue"
import { TooltipArrow, TooltipContent, TooltipPortal, TooltipRoot, TooltipTrigger } from "reka-ui"
import type { NativeEngineInfo, ProjectConfiguration } from "@yadaw/contracts"

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
}>()
const emit = defineEmits<{
  openPreferences: []
  toggleRecording: []
  togglePlayback: []
  goToStart: []
  save: []
  close: []
  openProjectSettings: []
}>()

const musicalPosition = computed(() => {
  const beatPosition = props.playheadSeconds / (60 / props.project.tempo)
  const bar = Math.floor(beatPosition / props.project.timeSignatureNumerator) + 1
  const beatInBar = beatPosition % props.project.timeSignatureNumerator
  const beat = Math.floor(beatInBar) + 1
  const ticks = Math.floor((beatInBar % 1) * 960)
  return `${String(bar).padStart(3, "0")}·${String(beat).padStart(2, "0")}·${String(ticks).padStart(3, "0")}`
})
</script>

<template>
  <header class="topbar">
    <div class="brand-lockup">
      <div class="brand-mark" aria-hidden="true"><span /><span /><span /></div>
      <div class="brand-copy"><strong>YADAW</strong><span>{{ project.name }}{{ dirty ? " · Unsaved" : "" }}</span></div>
    </div>

    <div class="transport" aria-label="Transport controls">
      <div class="transport-buttons">
        <TooltipRoot>
          <TooltipTrigger as-child><button aria-label="Go to start" @click="emit('goToStart')"><SkipBack :size="15" /></button></TooltipTrigger>
          <TooltipPortal><TooltipContent class="tooltip-content" :side-offset="9">Go to start <span>Home</span><TooltipArrow class="tooltip-arrow" /></TooltipContent></TooltipPortal>
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
          <TooltipPortal><TooltipContent class="tooltip-content" :side-offset="9">{{ playing ? "Pause" : "Play" }} <span>Space</span><TooltipArrow class="tooltip-arrow" /></TooltipContent></TooltipPortal>
        </TooltipRoot>
        <TooltipRoot>
          <TooltipTrigger as-child><button aria-label="Record" :class="['record', { active: recording }]" :disabled="(!engineRunning && !recording) || recordingBusy" @click="emit('toggleRecording')"><Circle :size="12" fill="currentColor" /></button></TooltipTrigger>
          <TooltipPortal><TooltipContent class="tooltip-content" :side-offset="9">Record <span>R</span><TooltipArrow class="tooltip-arrow" /></TooltipContent></TooltipPortal>
        </TooltipRoot>
      </div>
      <div class="time-display"><span>BAR · BEAT · TICK</span><strong>{{ musicalPosition }}</strong></div>
      <div class="tempo-display"><span><b>{{ project.tempo.toFixed(2) }}</b>BPM</span><span><b>{{ project.timeSignatureNumerator }} / {{ project.timeSignatureDenominator }}</b>METER</span></div>
    </div>

    <div class="top-actions">
      <div class="engine-badge">
        <span :class="['status-dot', { ready: nativeInfo && engineRunning }]" />
        <span class="engine-copy"><b>{{ engineRunning ? "Engine online" : "Engine standby" }}</b><small>{{ nativeInfo ? `${nativeInfo.backend} · N-API ${nativeInfo.nodeApi}` : "Connecting native core" }}</small></span>
      </div>
      <button class="preferences-button" aria-label="Project settings" @click="emit('openProjectSettings')"><SlidersHorizontal :size="15" /></button>
      <button class="preferences-button" aria-label="Save project" :disabled="!dirty" @click="emit('save')"><Save :size="15" /></button>
      <button class="preferences-button" aria-label="Close project" @click="emit('close')"><LogOut :size="15" /></button>
      <TooltipRoot>
        <TooltipTrigger as-child><button class="preferences-button" aria-label="Open preferences" @click="emit('openPreferences')"><Settings :size="16" /></button></TooltipTrigger>
        <TooltipPortal><TooltipContent class="tooltip-content" :side-offset="9">Preferences <span>Ctrl+,</span><TooltipArrow class="tooltip-arrow" /></TooltipContent></TooltipPortal>
      </TooltipRoot>
    </div>
  </header>
</template>

<style scoped>
.topbar{grid-column:1/-1;display:grid;grid-template-columns:minmax(210px,1fr) auto minmax(260px,1fr);align-items:center;min-width:0;padding:8px 14px;border-bottom:1px solid var(--line-strong);background:color-mix(in srgb,var(--surface-1) 94%,transparent);box-shadow:0 1px 0 #ffffff05 inset,0 10px 28px #02040a42;-webkit-app-region:drag}.topbar button{-webkit-app-region:no-drag}.brand-lockup,.top-actions,.engine-badge,.engine-copy,.transport,.transport-buttons,.tempo-display{display:flex;align-items:center}.brand-lockup{min-width:0;gap:11px}.brand-mark{display:flex;align-items:center;justify-content:center;width:35px;height:35px;gap:3px;border:1px solid #8c83ff80;border-radius:9px;background:linear-gradient(145deg,#302966,#171c38 62%,#172e39);box-shadow:0 0 0 1px #ffffff08 inset,0 8px 20px #06071680}.brand-mark span{width:3px;border-radius:2px;background:linear-gradient(#b5afff,#7be3ed);box-shadow:0 0 7px #8c83ff88}.brand-mark span:nth-child(1){height:10px}.brand-mark span:nth-child(2){height:21px}.brand-mark span:nth-child(3){height:15px}.brand-copy strong,.brand-copy span,.engine-copy b,.engine-copy small{display:block}.brand-copy strong{font-family:var(--font-display);font-size:13px;font-weight:700;letter-spacing:.2em}.brand-copy span{margin-top:3px;color:var(--text-muted);font-size:10px}.transport{justify-self:center;border:1px solid var(--line-strong);border-radius:10px;background:#090d16;box-shadow:0 1px 0 #ffffff08 inset,0 8px 24px #02040a80;overflow:hidden}.transport-buttons{gap:3px;padding:4px}.transport-buttons button,.preferences-button{display:grid;place-items:center;width:31px;height:31px;padding:0;border:1px solid transparent;border-radius:7px;color:var(--text-secondary);background:transparent;cursor:pointer}.transport-buttons button:hover,.preferences-button:hover{border-color:var(--line-strong);color:var(--text-primary);background:var(--surface-3)}.transport-buttons button:focus-visible,.preferences-button:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.transport-buttons button:disabled{cursor:not-allowed;opacity:.7}.transport-buttons .play{color:var(--signal-cyan)}.transport-buttons .record{color:var(--record)}.time-display{display:grid;align-self:stretch;align-content:center;min-width:136px;padding:0 16px;border-right:1px solid var(--line-soft);border-left:1px solid var(--line-soft)}.time-display span{color:#58657a;font:700 7px var(--font-utility);letter-spacing:.15em}.time-display strong{margin-top:2px;color:#d9e6f7;font:500 13px var(--font-utility);letter-spacing:.08em;text-shadow:0 0 16px #7be3ed44}.tempo-display{gap:13px;padding:0 12px;color:#59667a;font:7px var(--font-utility);letter-spacing:.06em}.tempo-display span,.tempo-display b{display:block}.tempo-display b{margin-bottom:2px;color:var(--text-secondary);font-size:9px;font-weight:500}.top-actions{justify-self:end;min-width:0;gap:8px}.engine-badge{min-width:0;gap:8px;margin-right:4px}.status-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--warning);box-shadow:0 0 9px var(--warning)}.status-dot.ready{background:var(--signal-cyan);box-shadow:0 0 9px var(--signal-cyan)}.engine-copy{min-width:0;align-items:flex-start;flex-direction:column}.engine-copy b{color:var(--text-secondary);font-size:9px;font-weight:650}.engine-copy small{margin-top:2px;color:var(--text-faint);font:7px var(--font-utility);white-space:nowrap}@media(max-width:1160px){.topbar{grid-template-columns:180px 1fr auto}.tempo-display,.engine-copy{display:none}}
.transport-buttons .record.active{color:#fff;background:var(--record);box-shadow:0 0 16px #ff657799}.preferences-button:disabled{cursor:not-allowed;opacity:.35}
.transport-buttons .play.active{color:#081116;background:var(--signal-cyan);box-shadow:0 0 14px #67d9e766}.spin{animation:spin 800ms linear infinite}@keyframes spin{to{transform:rotate(1turn)}}@media(prefers-reduced-motion:reduce){.spin{animation:none}}
</style>

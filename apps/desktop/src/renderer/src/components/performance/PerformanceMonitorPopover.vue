<script setup lang="ts">
import { storeToRefs } from "pinia"
import { computed } from "vue"
import {
  Activity,
  CircleAlert,
  Cpu,
  HardDrive,
  MemoryStick,
  Radio,
  RefreshCw,
  TriangleAlert
} from "@lucide/vue"
import type { AudioRuntimeSnapshot, StorageSpaceSnapshot } from "@yadaw/contracts"
import {
  PopoverArrow,
  PopoverContent,
  PopoverPortal,
  PopoverRoot,
  PopoverTrigger
} from "reka-ui"
import type { AudioTelemetryStatistics, AudioWarning } from "../../stores/audioRuntime"
import {
  classifyUpperBound,
  highestSeverity,
  PERFORMANCE_THRESHOLDS,
  storageSeverity,
  useSystemPerformanceStore
} from "../../stores/systemPerformance"
import type { HealthSeverity, PerformanceWarning } from "../../stores/systemPerformance"

const props = defineProps<{
  runtime: AudioRuntimeSnapshot
  statistics: AudioTelemetryStatistics
  audioWarnings: AudioWarning[]
}>()

const systemPerformanceStore = useSystemPerformanceStore()
const {
  snapshot,
  warnings: systemWarnings,
  severity: systemSeverity,
  isRefreshing
} = storeToRefs(systemPerformanceStore)

const monitoredRoundTripLatency = computed<number | null>(() => {
  if (props.runtime.state !== "running") return null
  const values = [
    props.runtime.estimatedRoundTripLatencyMs,
    props.statistics.averageRoundTripLatencyMs
  ].filter((value): value is number => value !== null)
  return values.length > 0 ? Math.max(...values) : null
})

const latencySeverity = computed<HealthSeverity>(() => {
  if (props.runtime.state !== "running") return "normal"
  return classifyUpperBound(
    monitoredRoundTripLatency.value,
    PERFORMANCE_THRESHOLDS.audioRoundTrip.warningMs,
    PERFORMANCE_THRESHOLDS.audioRoundTrip.criticalMs
  )
})

const audioSeverity = computed<HealthSeverity>(() => highestSeverity([
  latencySeverity.value,
  ...props.audioWarnings.map((warning) => warning.severity)
]))

const severity = computed<HealthSeverity>(() => highestSeverity([
  systemSeverity.value,
  audioSeverity.value
]))

const latencyWarning = computed<PerformanceWarning | null>(() => {
  if (latencySeverity.value === "normal") return null
  const value = props.runtime.estimatedRoundTripLatencyMs
  return {
    id: "audio-latency",
    severity: latencySeverity.value,
    title: latencySeverity.value === "critical" ? "Audio latency is critical" : "Audio latency is elevated",
    message: `Current or rolling round-trip latency is ${formatLatency(monitoredRoundTripLatency.value ?? value)}.`
  }
})

const activeWarnings = computed<PerformanceWarning[]>(() => [
  ...systemWarnings.value,
  ...props.audioWarnings.map((warning) => ({ ...warning })),
  ...(latencyWarning.value ? [latencyWarning.value] : [])
])

const cpuUsage = computed(() => snapshot.value?.cpu.overallUsagePercent ?? null)
const memoryUsage = computed(() => snapshot.value?.memory.usagePercent ?? null)
const workspaceSpace = computed(() => findStorage("workspace"))
const swapSpace = computed(() => findStorage("swap"))
const audioIpc = computed(() => snapshot.value?.audioIpc ?? null)

function findStorage(id: StorageSpaceSnapshot["id"]): StorageSpaceSnapshot | null {
  return snapshot.value?.storage.find((space) => space.id === id) ?? null
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`
}

function formatLatency(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`
}

function formatHeartbeatAge(value: number | null): string {
  return value === null ? "Waiting" : `${Math.round(value)} ms`
}

function formatOccupancy(used: number, capacity: number): string {
  return `${used.toLocaleString()} / ${capacity.toLocaleString()}`
}

function formatBytes(value: number | null): string {
  if (value === null) return "—"
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let scaled = value
  let unitIndex = 0
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024
    unitIndex += 1
  }
  return `${scaled.toLocaleString(undefined, { maximumFractionDigits: scaled >= 100 ? 0 : 1 })} ${units[unitIndex]}`
}

function spaceFreePercent(space: StorageSpaceSnapshot | null): number | null {
  if (!space || space.totalBytes === null || space.freeBytes === null || space.totalBytes <= 0) return null
  return space.freeBytes / space.totalBytes * 100
}

function spaceValue(space: StorageSpaceSnapshot | null): string {
  if (!space || space.state === "unconfigured") return "Not configured"
  if (space.state === "unavailable") return "Unavailable"
  return `${formatBytes(space.freeBytes)} free`
}

function spaceDetail(space: StorageSpaceSnapshot | null): string {
  if (!space || space.state === "unconfigured") return "Path will be supplied by project settings"
  if (space.state === "unavailable") return space.path ?? "Configured path cannot be read"
  return `${formatPercent(spaceFreePercent(space))} of ${formatBytes(space.totalBytes)}`
}

function coreStyle(usagePercent: number | null): Record<string, string> {
  return { "--core-load": `${usagePercent ?? 0}%` }
}

function coreSeverity(usagePercent: number | null): HealthSeverity {
  return classifyUpperBound(
    usagePercent,
    PERFORMANCE_THRESHOLDS.cpu.warningPercent,
    PERFORMANCE_THRESHOLDS.cpu.criticalPercent
  )
}
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger as-child>
      <button
        :class="['performance-trigger', severity]"
        :aria-label="`Open performance monitor. Status: ${severity}`"
      >
        <span class="health-light" aria-hidden="true" />
        <span>CPU {{ formatPercent(cpuUsage) }}</span>
        <span>MEM {{ formatPercent(memoryUsage) }}</span>
      </button>
    </PopoverTrigger>

    <PopoverPortal>
      <PopoverContent class="performance-popover" align="end" side="top" :side-offset="9">
        <header class="performance-header">
          <div>
            <span>Realtime headroom</span>
            <strong>Performance monitor</strong>
          </div>
          <div class="performance-header-actions">
            <span :class="['health-badge', severity]">{{ severity }}</span>
            <button
              class="refresh-performance"
              aria-label="Refresh performance data"
              :disabled="isRefreshing"
              @click="systemPerformanceStore.refresh"
            >
              <RefreshCw :class="{ spinning: isRefreshing }" :size="12" />
            </button>
          </div>
        </header>

        <div v-if="activeWarnings.length > 0" class="performance-alerts" aria-live="polite">
          <article
            v-for="warning in activeWarnings"
            :key="warning.id"
            :class="['performance-alert', warning.severity]"
          >
            <component :is="warning.severity === 'critical' ? CircleAlert : TriangleAlert" :size="12" />
            <div><strong>{{ warning.title }}</strong><span>{{ warning.message }}</span></div>
          </article>
        </div>

        <section class="performance-section cpu-section">
          <div class="section-heading">
            <div><Cpu :size="13" /><strong>CPU channels</strong></div>
            <span>{{ formatPercent(cpuUsage) }} total</span>
          </div>
          <div v-if="snapshot?.cpu.cores.length" class="core-bank">
            <div
              v-for="core in snapshot.cpu.cores"
              :key="core.index"
              :class="['core-channel', coreSeverity(core.usagePercent)]"
            >
              <span class="core-value">{{ formatPercent(core.usagePercent) }}</span>
              <span class="core-meter" :style="coreStyle(core.usagePercent)"><i /></span>
              <span class="core-label">C{{ String(core.index + 1).padStart(2, "0") }}</span>
            </div>
          </div>
          <div v-else class="monitor-placeholder">Sampling individual CPU cores…</div>
        </section>

        <section class="performance-section memory-section">
          <div class="section-heading">
            <div><MemoryStick :size="13" /><strong>Physical memory</strong></div>
            <span>{{ formatPercent(memoryUsage) }}</span>
          </div>
          <div class="memory-readout">
            <div class="linear-meter"><i :style="{ width: `${memoryUsage ?? 0}%` }" /></div>
            <span>{{ formatBytes(snapshot?.memory.usedBytes ?? null) }} used</span>
            <span>{{ formatBytes(snapshot?.memory.freeBytes ?? null) }} free</span>
            <span>{{ formatBytes(snapshot?.memory.totalBytes ?? null) }} total</span>
          </div>
        </section>

        <section class="performance-section storage-section">
          <div class="section-heading">
            <div><HardDrive :size="13" /><strong>Project storage</strong></div>
            <span>Free space</span>
          </div>
          <div class="storage-grid">
            <article :class="['storage-space', storageSeverity(workspaceSpace ?? { id: 'workspace', path: null, state: 'unconfigured', totalBytes: null, freeBytes: null })]">
              <span>Workspace</span><strong>{{ spaceValue(workspaceSpace) }}</strong><small>{{ spaceDetail(workspaceSpace) }}</small>
            </article>
            <article :class="['storage-space', storageSeverity(swapSpace ?? { id: 'swap', path: null, state: 'unconfigured', totalBytes: null, freeBytes: null })]">
              <span>Swap</span><strong>{{ spaceValue(swapSpace) }}</strong><small>{{ spaceDetail(swapSpace) }}</small>
            </article>
          </div>
        </section>

        <section class="performance-section audio-section">
          <div class="section-heading">
            <div><Radio :size="13" /><strong>Audio timing</strong></div>
            <span>{{ runtime.state }}</span>
          </div>
          <dl class="audio-timing-grid">
            <div><dt>Round trip</dt><dd>{{ formatLatency(runtime.estimatedRoundTripLatencyMs) }}</dd></div>
            <div><dt>Rolling avg</dt><dd>{{ formatLatency(statistics.averageRoundTripLatencyMs) }}</dd></div>
            <div><dt>Rolling max</dt><dd>{{ formatLatency(statistics.maximumRoundTripLatencyMs) }}</dd></div>
            <div><dt>Output</dt><dd>{{ formatLatency(runtime.outputLatencyMs) }}</dd></div>
            <div><dt>Buffer</dt><dd>{{ runtime.outputBufferSize ?? "—" }} frames</dd></div>
            <div :class="{ warning: statistics.sessionXruns > 0 }"><dt>XRUN</dt><dd>{{ statistics.sessionXruns }}</dd></div>
          </dl>
        </section>

        <section class="performance-section ipc-section">
          <div class="section-heading">
            <div><Activity :size="13" /><strong>Audio IPC transport</strong></div>
            <span>{{ audioIpc ? `Protocol v${audioIpc.protocolVersion}` : "Unavailable" }}</span>
          </div>
          <dl v-if="audioIpc" class="ipc-diagnostics-grid">
            <div>
              <dt>Request router</dt>
              <dd>{{ audioIpc.requests.normalPending }} normal · {{ audioIpc.requests.priorityPending }} priority</dd>
              <small>{{ audioIpc.requests.capacity }} slots per channel</small>
            </div>
            <div>
              <dt>Shared blobs</dt>
              <dd>{{ formatOccupancy(audioIpc.sharedMemory.outstandingLeases, audioIpc.sharedMemory.maxLeases) }} leases</dd>
              <small>{{ formatBytes(audioIpc.sharedMemory.outstandingBytes) }} / {{ formatBytes(audioIpc.sharedMemory.maxBytes) }} live · {{ audioIpc.sharedMemory.sharedPackets }} packets / {{ formatBytes(audioIpc.sharedMemory.sharedBytes) }} total</small>
            </div>
            <div>
              <dt>Inline payload</dt>
              <dd>{{ audioIpc.sharedMemory.inlinePackets.toLocaleString() }} packets</dd>
              <small>{{ formatBytes(audioIpc.sharedMemory.inlineBytes) }} serialized · {{ audioIpc.sharedMemory.sharedRegions }} shared regions</small>
            </div>
            <div>
              <dt>Telemetry page</dt>
              <dd>{{ formatOccupancy(audioIpc.telemetry.meterSlots, audioIpc.telemetry.capacity) }} meters</dd>
              <small>rev {{ audioIpc.telemetry.graphRevision }} · {{ audioIpc.telemetry.fallbackReads }} fallback reads</small>
            </div>
            <div>
              <dt>Parameter SPSC</dt>
              <dd>{{ formatOccupancy(audioIpc.parameterRing.used, audioIpc.parameterRing.capacity) }}</dd>
              <small>{{ audioIpc.parameterRing.softFull }} soft · {{ audioIpc.parameterRing.hardFull }} full · {{ audioIpc.parameterRing.boundaryFallbacks }} boundary</small>
            </div>
            <div>
              <dt>Priority heartbeat</dt>
              <dd>{{ formatHeartbeatAge(audioIpc.heartbeat.ageMs) }}</dd>
              <small>IPC {{ audioIpc.heartbeat.ipcGeneration }} · Tokio {{ audioIpc.heartbeat.tokioGeneration }} · UI {{ audioIpc.heartbeat.winitGeneration }}</small>
            </div>
            <div>
              <dt>Router health</dt>
              <dd>{{ audioIpc.eventQueueDepth }} events · {{ audioIpc.requests.timeouts }} timeouts</dd>
              <small>callback {{ audioIpc.telemetry.callbackGeneration }} · stale {{ audioIpc.parameterRing.staleEpoch }}</small>
            </div>
          </dl>
          <div v-else class="monitor-placeholder">Audio helper diagnostics are unavailable.</div>
        </section>

        <footer class="threshold-note">
          Warning / critical · CPU {{ PERFORMANCE_THRESHOLDS.cpu.warningPercent }}/{{ PERFORMANCE_THRESHOLDS.cpu.criticalPercent }}% · MEM {{ PERFORMANCE_THRESHOLDS.memory.warningPercent }}/{{ PERFORMANCE_THRESHOLDS.memory.criticalPercent }}% · RTL {{ PERFORMANCE_THRESHOLDS.audioRoundTrip.warningMs }}/{{ PERFORMANCE_THRESHOLDS.audioRoundTrip.criticalMs }} ms
        </footer>
        <PopoverArrow class="performance-popover-arrow" />
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

<style>
.performance-trigger{display:flex;align-items:center;height:20px;padding:0 7px;border:1px solid transparent;border-radius:4px;gap:8px;color:var(--text-muted);background:transparent;font:7px var(--font-utility);letter-spacing:.04em;cursor:pointer}.performance-trigger:hover{border-color:var(--line-strong);color:var(--text-secondary);background:var(--daw-control)}.performance-trigger:focus-visible,.refresh-performance:focus-visible{outline:2px solid var(--focus);outline-offset:2px}.performance-trigger.warning{border-color:color-mix(in srgb,var(--warning) 45%,var(--line-strong));color:var(--warning);background:color-mix(in srgb,var(--warning) 10%,var(--daw-statusbar))}.performance-trigger.critical{border-color:color-mix(in srgb,var(--record) 45%,var(--line-strong));color:var(--record);background:color-mix(in srgb,var(--record) 10%,var(--daw-statusbar))}.health-light{width:5px;height:5px;border-radius:50%;background:var(--signal-cyan);box-shadow:0 0 6px color-mix(in srgb,var(--signal-cyan) 60%,transparent)}.warning .health-light{background:var(--warning);box-shadow:0 0 7px color-mix(in srgb,var(--warning) 66%,transparent)}.critical .health-light{background:var(--record);box-shadow:0 0 7px color-mix(in srgb,var(--record) 72%,transparent)}
.performance-popover{z-index:100;width:520px;max-width:calc(100vw - 24px);max-height:calc(100vh - 48px);overflow:auto;padding:0;border:1px solid var(--line-strong);border-radius:10px;outline:none;color:var(--text-primary);background:var(--surface-panel);box-shadow:0 24px 64px var(--shadow);transform-origin:var(--reka-popover-content-transform-origin);animation:performance-surface-in 120ms ease-out}.performance-header{position:sticky;z-index:2;top:0;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:13px 15px;border-bottom:1px solid var(--line-soft);background:color-mix(in srgb,var(--surface-2) 93%,transparent);backdrop-filter:blur(10px)}.performance-header>div:first-child>span,.performance-header>div:first-child>strong{display:block}.performance-header>div:first-child>span{color:var(--accent);font:700 7px var(--font-utility);text-transform:uppercase;letter-spacing:.16em}.performance-header>div:first-child>strong{margin-top:4px;font-size:11px}.performance-header-actions{display:flex;align-items:center;gap:7px}.health-badge{padding:4px 7px;border:1px solid color-mix(in srgb,var(--signal-cyan) 50%,var(--line-strong));border-radius:4px;color:var(--signal-cyan);background:color-mix(in srgb,var(--signal-cyan) 10%,var(--surface-2));font:7px var(--font-utility);text-transform:uppercase;letter-spacing:.08em}.health-badge.warning{border-color:color-mix(in srgb,var(--warning) 45%,var(--line-strong));color:var(--warning);background:color-mix(in srgb,var(--warning) 10%,var(--surface-2))}.health-badge.critical{border-color:color-mix(in srgb,var(--record) 45%,var(--line-strong));color:var(--record);background:color-mix(in srgb,var(--record) 10%,var(--surface-2))}.refresh-performance{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--line-strong);border-radius:5px;color:var(--text-muted);background:var(--daw-control);cursor:pointer}.refresh-performance:hover{color:var(--text-primary);background:var(--daw-control-hover)}.refresh-performance:disabled{cursor:wait;opacity:.55}.spinning{animation:monitor-spin .8s linear infinite}
.performance-alerts{display:grid;padding:8px;border-bottom:1px solid var(--line-soft);gap:5px;background:var(--surface-panel)}.performance-alert{display:grid;grid-template-columns:15px minmax(0,1fr);align-items:start;padding:7px 8px;border:1px solid color-mix(in srgb,var(--warning) 42%,var(--line-strong));border-radius:6px;gap:7px;color:var(--warning);background:color-mix(in srgb,var(--warning) 10%,var(--surface-1))}.performance-alert.critical{border-color:color-mix(in srgb,var(--record) 45%,var(--line-strong));color:var(--record);background:color-mix(in srgb,var(--record) 10%,var(--surface-1))}.performance-alert div{min-width:0}.performance-alert strong,.performance-alert span{display:block}.performance-alert strong{font-size:8px}.performance-alert span{margin-top:3px;color:var(--text-muted);font-size:7px;line-height:1.45}.performance-alert.critical span{color:var(--text-muted)}
.performance-section{padding:12px 15px;border-bottom:1px solid var(--line-soft)}.section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}.section-heading>div{display:flex;align-items:center;gap:7px;color:var(--text-secondary)}.section-heading strong{font-size:9px}.section-heading>span{color:var(--text-faint);font:7px var(--font-utility);text-transform:uppercase;letter-spacing:.06em}.core-bank{display:grid;grid-template-columns:repeat(auto-fit,minmax(30px,1fr));gap:5px}.core-channel{display:grid;grid-template-rows:10px 46px 10px;justify-items:center;gap:4px;min-width:0}.core-value,.core-label{color:var(--text-faint);font:6px var(--font-utility)}.core-meter{position:relative;width:9px;height:46px;overflow:hidden;border:1px solid var(--line-strong);border-radius:2px;background:repeating-linear-gradient(to top,var(--daw-control) 0,var(--daw-control) 4px,var(--daw-meter-well) 4px,var(--daw-meter-well) 6px)}.core-meter i{position:absolute;right:0;bottom:0;left:0;height:var(--core-load);background:linear-gradient(to top,var(--accent),var(--signal-cyan));box-shadow:0 0 7px color-mix(in srgb,var(--signal-cyan) 40%,transparent)}.core-channel.warning .core-meter i{background:var(--warning);box-shadow:0 0 7px color-mix(in srgb,var(--warning) 53%,transparent)}.core-channel.critical .core-meter i{background:var(--record);box-shadow:0 0 7px color-mix(in srgb,var(--record) 60%,transparent)}.core-channel.warning .core-value{color:var(--warning)}.core-channel.critical .core-value{color:var(--record)}.monitor-placeholder{padding:15px;border:1px dashed var(--line-strong);border-radius:6px;color:var(--text-faint);font-size:8px;text-align:center}
.memory-readout{display:grid;grid-template-columns:minmax(0,1fr) repeat(3,auto);align-items:center;gap:10px}.linear-meter{height:6px;overflow:hidden;border:1px solid var(--line-strong);border-radius:2px;background:var(--daw-meter-well)}.linear-meter i{display:block;height:100%;background:linear-gradient(90deg,var(--accent),var(--signal-cyan));box-shadow:0 0 8px color-mix(in srgb,var(--signal-cyan) 40%,transparent)}.memory-readout>span{color:var(--text-faint);font:7px var(--font-utility)}.storage-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px}.storage-space{min-width:0;padding:9px 10px;border:1px solid var(--line-soft);border-radius:6px;background:var(--surface-1)}.storage-space>span,.storage-space>strong,.storage-space>small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.storage-space>span{color:var(--text-faint);font:7px var(--font-utility);text-transform:uppercase;letter-spacing:.07em}.storage-space>strong{margin-top:5px;color:var(--text-secondary);font:9px var(--font-utility)}.storage-space>small{margin-top:4px;color:var(--text-muted);font-size:7px}.storage-space.warning{border-color:color-mix(in srgb,var(--warning) 42%,var(--line-strong));background:color-mix(in srgb,var(--warning) 10%,var(--surface-1))}.storage-space.warning>strong{color:var(--warning)}.storage-space.critical{border-color:color-mix(in srgb,var(--record) 45%,var(--line-strong));background:color-mix(in srgb,var(--record) 10%,var(--surface-1))}.storage-space.critical>strong{color:var(--record)}
.audio-timing-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:0;gap:6px}.audio-timing-grid>div{min-width:0;padding:8px;border:1px solid var(--line-soft);border-radius:5px;background:var(--surface-1)}.audio-timing-grid dt{color:var(--text-faint);font-size:7px}.audio-timing-grid dd{margin:4px 0 0;color:var(--signal-cyan);font:8px var(--font-utility);white-space:nowrap}.audio-timing-grid .warning{border-color:color-mix(in srgb,var(--warning) 42%,var(--line-strong))}.audio-timing-grid .warning dd{color:var(--warning)}.threshold-note{padding:8px 15px;color:var(--text-faint);background:var(--surface-sunken);font:6px var(--font-utility);line-height:1.5}.performance-popover-arrow{fill:var(--line-strong)}
.ipc-diagnostics-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.ipc-diagnostics-grid>div{min-width:0;padding:8px;border:1px solid var(--line-soft);border-radius:5px;background:var(--surface-1)}.ipc-diagnostics-grid dt{color:var(--text-faint);font-size:7px}.ipc-diagnostics-grid dd{overflow:hidden;margin:4px 0 0;color:var(--signal-cyan);font:8px var(--font-utility);text-overflow:ellipsis;white-space:nowrap}.ipc-diagnostics-grid small{display:block;overflow:hidden;margin-top:4px;color:var(--text-faint);font:6px var(--font-utility);line-height:1.35;text-overflow:ellipsis;white-space:nowrap}
@keyframes monitor-spin{to{transform:rotate(360deg)}}
@keyframes performance-surface-in{from{opacity:0;transform:translateY(3px) scale(.98)}}
@media(max-width:700px){.memory-readout{grid-template-columns:1fr 1fr}.linear-meter{grid-column:1/-1}.storage-grid{grid-template-columns:1fr}.audio-timing-grid,.ipc-diagnostics-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(prefers-reduced-motion:reduce){.spinning{animation:none}}
</style>

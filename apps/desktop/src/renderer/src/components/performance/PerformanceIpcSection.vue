<script setup lang="ts">
import { computed } from "vue"
import { Activity } from "@lucide/vue"
import type { AudioIpcPerformanceSnapshot } from "@yadaw/contracts"

const props = defineProps<{ audioIpc: AudioIpcPerformanceSnapshot | null }>()
const buildLabel = computed(() => {
  const fingerprint = props.audioIpc?.nativeBuildFingerprint
  return fingerprint ? `Build ${fingerprint.slice(0, 8)}` : "Unavailable"
})
function formatHeartbeatAge(value: number | null): string {
  return value === null ? "Waiting" : `${Math.round(value)} ms`
}
function formatOccupancy(used: number, capacity: number): string {
  return `${used.toLocaleString()} / ${capacity.toLocaleString()}`
}
function formatBytes(value: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  let scaled = value
  let unitIndex = 0
  while (scaled >= 1024 && unitIndex < units.length - 1) {
    scaled /= 1024
    unitIndex += 1
  }
  return `${scaled.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
</script>

<template>
  <section class="performance-section ipc-section">
    <div class="section-heading">
      <div><Activity :size="13" /><strong>Audio IPC transport</strong></div>
      <span>{{ buildLabel }}</span>
    </div>
    <dl v-if="audioIpc" class="ipc-diagnostics-grid">
      <div>
        <dt>Request router</dt>
        <dd>
          {{ audioIpc.requests.normalPending }} normal ·
          {{ audioIpc.requests.priorityPending }} priority
        </dd>
        <small>{{ audioIpc.requests.capacity }} slots per channel</small>
      </div>
      <div>
        <dt>Arena leases</dt>
        <dd>
          {{
            formatOccupancy(
              audioIpc.sharedMemory.outstandingLeases,
              audioIpc.sharedMemory.maxLeases
            )
          }}
          leases
        </dd>
        <small
          >{{ formatBytes(audioIpc.sharedMemory.outstandingBytes) }} /
          {{ formatBytes(audioIpc.sharedMemory.maxBytes) }} live ·
          {{ audioIpc.sharedMemory.sharedPackets }} packets /
          {{ formatBytes(audioIpc.sharedMemory.sharedBytes) }} total</small
        >
      </div>
      <div>
        <dt>Bulk arena</dt>
        <dd>
          {{ formatBytes(audioIpc.sharedMemory.arenaUsedBytes) }} /
          {{ formatBytes(audioIpc.sharedMemory.arenaCapacityBytes) }}
        </dd>
        <small
          >{{ audioIpc.sharedMemory.arenaRegions }} regions ·
          {{ audioIpc.sharedMemory.arenaOffers }} offers ·
          {{ audioIpc.sharedMemory.arenaBusy }} busy ·
          {{ audioIpc.sharedMemory.arenaQuarantinedRegions }} quarantine</small
        >
      </div>
      <div>
        <dt>Runtime workers</dt>
        <dd>
          {{ audioIpc.runtime.resolved.workerThreads }} async ·
          {{ audioIpc.runtime.resolved.maxBlockingThreads }} blocking
        </dd>
        <small
          >{{ audioIpc.runtime.resolved.egressConcurrency }} egress concurrency ·
          {{ audioIpc.runtime.blockingJobs }} blocking active</small
        >
      </div>
      <div>
        <dt>Async egress</dt>
        <dd>
          {{ audioIpc.runtime.egressActive }} active ·
          {{ audioIpc.runtime.egressQueueDepth }} queued
        </dd>
        <small
          >{{ audioIpc.runtime.egressQueueHighWater }} high-water ·
          {{ audioIpc.runtime.egressBatches }} batches ·
          {{ formatBytes(audioIpc.sharedMemory.copiedBytes) }} copied</small
        >
      </div>
      <div>
        <dt>Inline payload</dt>
        <dd>{{ audioIpc.sharedMemory.inlinePackets.toLocaleString() }} packets</dd>
        <small
          >{{ formatBytes(audioIpc.sharedMemory.inlineBytes) }} serialized ·
          {{ audioIpc.sharedMemory.sharedRegions }} shared regions</small
        >
      </div>
      <div>
        <dt>Telemetry page</dt>
        <dd>
          {{ formatOccupancy(audioIpc.telemetry.meterSlots, audioIpc.telemetry.capacity) }} meters
        </dd>
        <small
          >rev {{ audioIpc.telemetry.graphRevision }} ·
          {{ audioIpc.telemetry.fallbackReads }} fallback reads</small
        >
      </div>
      <div>
        <dt>Parameter SPSC</dt>
        <dd>{{ formatOccupancy(audioIpc.parameterRing.used, audioIpc.parameterRing.capacity) }}</dd>
        <small
          >{{ audioIpc.parameterRing.softFull }} soft · {{ audioIpc.parameterRing.hardFull }} full ·
          {{ audioIpc.parameterRing.boundaryFallbacks }} boundary</small
        >
      </div>
      <div>
        <dt>Priority heartbeat</dt>
        <dd>{{ formatHeartbeatAge(audioIpc.heartbeat.ageMs) }}</dd>
        <small
          >IPC {{ audioIpc.heartbeat.ipcGeneration }} · Tokio
          {{ audioIpc.heartbeat.tokioGeneration }} · UI
          {{ audioIpc.heartbeat.winitGeneration }}</small
        >
      </div>
      <div>
        <dt>Router health</dt>
        <dd>{{ audioIpc.eventQueueDepth }} events · {{ audioIpc.requests.timeouts }} timeouts</dd>
        <small
          >callback {{ audioIpc.telemetry.callbackGeneration }} · stale
          {{ audioIpc.parameterRing.staleEpoch }}</small
        >
      </div>
    </dl>
    <div v-else class="monitor-placeholder">Audio helper diagnostics are unavailable.</div>
  </section>
</template>

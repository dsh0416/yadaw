<script setup lang="ts">
import { Activity } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import type { AudioIpcPerformanceSnapshot } from "@heron/contracts"

const props = defineProps<{ audioIpc: AudioIpcPerformanceSnapshot | null }>()
const { t } = useI18n()
function formatHeartbeatAge(value: number | null): string {
  return value === null ? t("performance.ipcSection.waiting") : `${Math.round(value)} ms`
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
      <div>
        <Activity :size="13" /><strong>{{ t("performance.ipcSection.title") }}</strong>
      </div>
      <span>{{ props.audioIpc?.sessionEpoch ?? t("performance.ipcSection.unavailable") }}</span>
    </div>
    <dl v-if="audioIpc" class="ipc-diagnostics-grid">
      <div>
        <dt>{{ t("performance.ipcSection.requestRouter") }}</dt>
        <dd>
          {{
            t("performance.ipcSection.normalPriority", {
              normal: audioIpc.requests.normalPending,
              priority: audioIpc.requests.priorityPending
            })
          }}
        </dd>
        <small>{{
          t("performance.ipcSection.slotsPerChannel", { count: audioIpc.requests.capacity })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.arenaLeases") }}</dt>
        <dd>
          {{
            formatOccupancy(
              audioIpc.sharedMemory.outstandingLeases,
              audioIpc.sharedMemory.maxLeases
            )
          }}
          {{ t("performance.ipcSection.leases") }}
        </dd>
        <small>{{
          t("performance.ipcSection.liveTotal", {
            live: `${formatBytes(audioIpc.sharedMemory.outstandingBytes)} / ${formatBytes(audioIpc.sharedMemory.maxBytes)}`,
            packets: audioIpc.sharedMemory.sharedPackets,
            total: formatBytes(audioIpc.sharedMemory.sharedBytes)
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.bulkArena") }}</dt>
        <dd>
          {{ formatBytes(audioIpc.sharedMemory.arenaUsedBytes) }} /
          {{ formatBytes(audioIpc.sharedMemory.arenaCapacityBytes) }}
        </dd>
        <small>{{
          t("performance.ipcSection.regionsDetail", {
            regions: audioIpc.sharedMemory.arenaRegions,
            offers: audioIpc.sharedMemory.arenaOffers,
            busy: audioIpc.sharedMemory.arenaBusy,
            quarantine: audioIpc.sharedMemory.arenaQuarantinedRegions
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.runtimeWorkers") }}</dt>
        <dd>
          {{
            t("performance.ipcSection.asyncBlocking", {
              async: audioIpc.runtime.resolved.workerThreads,
              blocking: audioIpc.runtime.resolved.maxBlockingThreads
            })
          }}
        </dd>
        <small>{{
          t("performance.ipcSection.egressDetail", {
            egress: audioIpc.runtime.resolved.egressConcurrency,
            active: audioIpc.runtime.blockingJobs
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.asyncEgress") }}</dt>
        <dd>
          {{
            t("performance.ipcSection.activeQueued", {
              active: audioIpc.runtime.egressActive,
              queued: audioIpc.runtime.egressQueueDepth
            })
          }}
        </dd>
        <small>{{
          t("performance.ipcSection.egressStats", {
            highWater: audioIpc.runtime.egressQueueHighWater,
            batches: audioIpc.runtime.egressBatches,
            copied: formatBytes(audioIpc.sharedMemory.copiedBytes)
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.inlinePayload") }}</dt>
        <dd>
          {{ audioIpc.sharedMemory.inlinePackets.toLocaleString() }}
          {{ t("performance.ipcSection.packets") }}
        </dd>
        <small>{{
          t("performance.ipcSection.serializedRegions", {
            serialized: formatBytes(audioIpc.sharedMemory.inlineBytes),
            regions: audioIpc.sharedMemory.sharedRegions
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.telemetryPage") }}</dt>
        <dd>
          {{ formatOccupancy(audioIpc.telemetry.meterSlots, audioIpc.telemetry.capacity) }}
          {{ t("performance.ipcSection.meters") }}
        </dd>
        <small>{{
          t("performance.ipcSection.telemetryDetail", {
            revision: audioIpc.telemetry.graphRevision,
            fallbackReads: audioIpc.telemetry.fallbackReads
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.parameterSpsc") }}</dt>
        <dd>{{ formatOccupancy(audioIpc.parameterRing.used, audioIpc.parameterRing.capacity) }}</dd>
        <small>{{
          t("performance.ipcSection.ringDetail", {
            softFull: audioIpc.parameterRing.softFull,
            hardFull: audioIpc.parameterRing.hardFull,
            boundary: audioIpc.parameterRing.boundaryFallbacks
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.priorityHeartbeat") }}</dt>
        <dd>{{ formatHeartbeatAge(audioIpc.heartbeat.ageMs) }}</dd>
        <small>{{
          t("performance.ipcSection.heartbeatDetail", {
            ipcGeneration: audioIpc.heartbeat.ipcGeneration,
            tokioGeneration: audioIpc.heartbeat.tokioGeneration,
            winitGeneration: audioIpc.heartbeat.winitGeneration
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.routerHealth") }}</dt>
        <dd>
          {{
            t("performance.ipcSection.eventsTimeouts", {
              events: audioIpc.eventQueueDepth,
              timeouts: audioIpc.requests.timeouts
            })
          }}
        </dd>
        <small>{{
          t("performance.ipcSection.callbackStale", {
            callbackGeneration: audioIpc.telemetry.callbackGeneration,
            staleEpoch: audioIpc.parameterRing.staleEpoch
          })
        }}</small>
      </div>
    </dl>
    <div v-else class="monitor-placeholder">{{ t("performance.ipcSection.placeholder") }}</div>
  </section>
</template>

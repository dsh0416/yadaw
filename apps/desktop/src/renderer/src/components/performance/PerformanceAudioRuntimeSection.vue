<script setup lang="ts">
import { Activity } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import type { AudioRuntimePerformanceSnapshot } from "@heron/contracts"

const props = defineProps<{ audioRuntime: AudioRuntimePerformanceSnapshot | null }>()
const { t } = useI18n()

function formatHeartbeatAge(value: number | null): string {
  return value === null ? t("performance.ipcSection.waiting") : `${Math.round(value)} ms`
}

function formatOccupancy(used: number, capacity: number): string {
  return `${used.toLocaleString()} / ${capacity.toLocaleString()}`
}
</script>

<template>
  <section class="performance-section audio-runtime-section">
    <div class="section-heading">
      <div>
        <Activity :size="13" /><strong>{{ t("performance.ipcSection.title") }}</strong>
      </div>
      <span>{{ props.audioRuntime?.sessionEpoch ?? t("performance.ipcSection.unavailable") }}</span>
    </div>
    <dl v-if="audioRuntime" class="ipc-diagnostics-grid">
      <div>
        <dt>{{ t("performance.ipcSection.requestRouter") }}</dt>
        <dd>
          {{
            t("performance.ipcSection.normalPriority", {
              normal: audioRuntime.requests.normalPending
            })
          }}
        </dd>
        <small>{{
          t("performance.ipcSection.slotsPerChannel", { count: audioRuntime.requests.capacity })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.runtimeWorkers") }}</dt>
        <dd>
          {{
            t("performance.ipcSection.asyncBlocking", {
              async: audioRuntime.runtime.resolved.workerThreads,
              blocking: audioRuntime.runtime.resolved.maxBlockingThreads
            })
          }}
        </dd>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.telemetryPage") }}</dt>
        <dd>
          {{ formatOccupancy(audioRuntime.telemetry.meterSlots, audioRuntime.telemetry.capacity) }}
          {{ t("performance.ipcSection.meters") }}
        </dd>
        <small>{{
          t("performance.ipcSection.telemetryDetail", {
            revision: audioRuntime.telemetry.graphRevision
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.parameterSpsc") }}</dt>
        <dd>
          {{
            formatOccupancy(audioRuntime.parameterRing.used, audioRuntime.parameterRing.capacity)
          }}
        </dd>
        <small>{{
          t("performance.ipcSection.ringDetail", {
            hardFull: audioRuntime.parameterRing.hardFull,
            stale: audioRuntime.parameterRing.staleEpoch
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.priorityHeartbeat") }}</dt>
        <dd>{{ formatHeartbeatAge(audioRuntime.heartbeat.ageMs) }}</dd>
        <small>{{
          t("performance.ipcSection.heartbeatDetail", {
            controlGeneration: audioRuntime.heartbeat.controlGeneration,
            tokioGeneration: audioRuntime.heartbeat.tokioGeneration,
            winitGeneration: audioRuntime.heartbeat.winitGeneration
          })
        }}</small>
      </div>
      <div>
        <dt>{{ t("performance.ipcSection.routerHealth") }}</dt>
        <dd>
          {{
            t("performance.ipcSection.eventsTimeouts", {
              events: audioRuntime.eventQueueDepth,
              timeouts: audioRuntime.requests.timeouts
            })
          }}
        </dd>
        <small>{{
          t("performance.ipcSection.callbackStale", {
            callbackGeneration: audioRuntime.telemetry.callbackGeneration,
            staleEpoch: audioRuntime.parameterRing.staleEpoch
          })
        }}</small>
      </div>
    </dl>
    <div v-else class="monitor-placeholder">{{ t("performance.ipcSection.placeholder") }}</div>
  </section>
</template>

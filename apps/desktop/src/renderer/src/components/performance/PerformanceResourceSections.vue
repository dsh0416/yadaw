<script setup lang="ts">
import { computed } from "vue"
import { Cpu, HardDrive, MemoryStick } from "@lucide/vue"
import { useI18n } from "vue-i18n"
import type { StorageSpaceSnapshot, SystemPerformanceSnapshot } from "@yadaw/contracts"
import {
  classifyUpperBound,
  PERFORMANCE_THRESHOLDS,
  storageSeverity
} from "../../stores/systemPerformance"
import type { HealthSeverity } from "../../stores/systemPerformance"

const props = defineProps<{ snapshot: SystemPerformanceSnapshot | null }>()
const { t } = useI18n()
const cpuUsage = computed(() => props.snapshot?.cpu.overallUsagePercent ?? null)
const memoryUsage = computed(() => props.snapshot?.memory.usagePercent ?? null)
const workspaceSpace = computed(() => findStorage("workspace"))
const swapSpace = computed(() => findStorage("swap"))

const storageLabels = computed(() => [
  {
    key: "workspace" as const,
    label: t("performance.resourceSections.workspace"),
    space: workspaceSpace.value
  },
  { key: "swap" as const, label: t("performance.resourceSections.swap"), space: swapSpace.value }
])

function findStorage(id: StorageSpaceSnapshot["id"]): StorageSpaceSnapshot | null {
  return props.snapshot?.storage.find((space) => space.id === id) ?? null
}
function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)}%`
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
  return `${scaled.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
function spaceFreePercent(space: StorageSpaceSnapshot | null): number | null {
  if (!space || space.freeBytes === null || space.totalBytes === null || space.totalBytes <= 0)
    return null
  return (space.freeBytes / space.totalBytes) * 100
}
function spaceValue(space: StorageSpaceSnapshot | null): string {
  const percent = spaceFreePercent(space)
  return percent === null
    ? "—"
    : t("performance.resourceSections.percentFree", { percent: Math.round(percent) })
}
function spaceDetail(space: StorageSpaceSnapshot | null): string {
  if (!space || space.freeBytes === null) {
    return space?.state === "unconfigured"
      ? t("performance.resourceSections.unconfigured")
      : (space?.state ?? t("performance.resourceSections.unconfigured"))
  }
  return t("performance.resourceSections.available", { size: formatBytes(space.freeBytes) })
}
function coreStyle(usagePercent: number | null): Record<string, string> {
  return { "--core-level": `${Math.max(0, Math.min(100, usagePercent ?? 0))}%` }
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
  <section class="performance-section cpu-section">
    <div class="section-heading">
      <div>
        <Cpu :size="13" /><strong>{{ t("performance.resourceSections.cpuChannels") }}</strong>
      </div>
      <span>{{
        t("performance.resourceSections.total", { percent: formatPercent(cpuUsage) })
      }}</span>
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
    <div v-else class="monitor-placeholder">
      {{ t("performance.resourceSections.samplingCores") }}
    </div>
  </section>
  <section class="performance-section memory-section">
    <div class="section-heading">
      <div>
        <MemoryStick :size="13" /><strong>{{
          t("performance.resourceSections.physicalMemory")
        }}</strong>
      </div>
      <span>{{ formatPercent(memoryUsage) }}</span>
    </div>
    <div class="memory-readout">
      <div class="linear-meter"><i :style="{ width: `${memoryUsage ?? 0}%` }" /></div>
      <span>{{
        t("performance.resourceSections.used", {
          size: formatBytes(snapshot?.memory.usedBytes ?? null)
        })
      }}</span>
      <span>{{
        t("performance.resourceSections.free", {
          size: formatBytes(snapshot?.memory.freeBytes ?? null)
        })
      }}</span>
      <span>{{
        t("performance.resourceSections.totalMemory", {
          size: formatBytes(snapshot?.memory.totalBytes ?? null)
        })
      }}</span>
    </div>
  </section>
  <section class="performance-section storage-section">
    <div class="section-heading">
      <div>
        <HardDrive :size="13" /><strong>{{
          t("performance.resourceSections.projectStorage")
        }}</strong>
      </div>
      <span>{{ t("performance.resourceSections.freeSpace") }}</span>
    </div>
    <div class="storage-grid">
      <article
        v-for="entry in storageLabels"
        :key="entry.key"
        :class="[
          'storage-space',
          storageSeverity(
            entry.space ?? {
              id: entry.key,
              path: null,
              state: 'unconfigured',
              totalBytes: null,
              freeBytes: null
            }
          )
        ]"
      >
        <span>{{ entry.label }}</span
        ><strong>{{ spaceValue(entry.space) }}</strong
        ><small>{{ spaceDetail(entry.space) }}</small>
      </article>
    </div>
  </section>
</template>

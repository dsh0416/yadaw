import { useIntervalFn } from "@vueuse/core"
import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type { StorageSpaceSnapshot, SystemPerformanceSnapshot } from "@yadaw/contracts"

const POLLING_INTERVAL_MS = 1_000
const GIBIBYTE = 1024 ** 3

export type HealthSeverity = "normal" | "warning" | "critical"

export interface PerformanceWarning {
  id: string
  severity: Exclude<HealthSeverity, "normal">
  title: string
  message: string
}

export const PERFORMANCE_THRESHOLDS = {
  cpu: { warningPercent: 70, criticalPercent: 90 },
  memory: { warningPercent: 75, criticalPercent: 90 },
  storage: {
    warningFreePercent: 15,
    criticalFreePercent: 5,
    warningFreeBytes: 20 * GIBIBYTE,
    criticalFreeBytes: 5 * GIBIBYTE
  },
  audioRoundTrip: { warningMs: 20, criticalMs: 40 },
  audioIpc: {
    warningUtilizationPercent: 75,
    criticalUtilizationPercent: 90,
    warningHeartbeatAgeMs: 750,
    criticalHeartbeatAgeMs: 1_500
  }
} as const

function severityRank(severity: HealthSeverity): number {
  if (severity === "critical") return 2
  if (severity === "warning") return 1
  return 0
}

export function highestSeverity(severities: HealthSeverity[]): HealthSeverity {
  return severities.reduce<HealthSeverity>(
    (highest, severity) => (severityRank(severity) > severityRank(highest) ? severity : highest),
    "normal"
  )
}

export function classifyUpperBound(
  value: number | null,
  warningThreshold: number,
  criticalThreshold: number
): HealthSeverity {
  if (value === null) return "normal"
  if (value >= criticalThreshold) return "critical"
  if (value >= warningThreshold) return "warning"
  return "normal"
}

function utilizationPercent(used: number, capacity: number): number {
  return capacity > 0 ? (used / capacity) * 100 : 0
}

export function storageSeverity(space: StorageSpaceSnapshot): HealthSeverity {
  if (space.state === "unavailable") return "warning"
  if (
    space.state !== "available" ||
    space.totalBytes === null ||
    space.freeBytes === null ||
    space.totalBytes <= 0
  ) {
    return "normal"
  }

  const freePercent = (space.freeBytes / space.totalBytes) * 100
  if (
    freePercent <= PERFORMANCE_THRESHOLDS.storage.criticalFreePercent ||
    space.freeBytes <= PERFORMANCE_THRESHOLDS.storage.criticalFreeBytes
  ) {
    return "critical"
  }
  if (
    freePercent <= PERFORMANCE_THRESHOLDS.storage.warningFreePercent ||
    space.freeBytes <= PERFORMANCE_THRESHOLDS.storage.warningFreeBytes
  ) {
    return "warning"
  }
  return "normal"
}

export const useSystemPerformanceStore = defineStore("system-performance", () => {
  const snapshot = shallowRef<SystemPerformanceSnapshot | null>(null)
  const lastError = shallowRef("")
  const isRefreshing = shallowRef(false)

  async function refresh(): Promise<void> {
    if (isRefreshing.value) return
    isRefreshing.value = true
    try {
      snapshot.value = await window.yadaw.systemPerformanceSnapshot()
      lastError.value = ""
    } catch (error) {
      lastError.value =
        error instanceof Error ? error.message : "Unable to read system performance."
    } finally {
      isRefreshing.value = false
    }
  }

  const polling = useIntervalFn(() => void refresh(), POLLING_INTERVAL_MS, { immediate: false })

  function startPolling(): void {
    void refresh()
    polling.resume()
  }

  function stopPolling(): void {
    polling.pause()
  }

  const maximumCoreUsagePercent = computed<number | null>(() => {
    const values =
      snapshot.value?.cpu.cores
        .map((core) => core.usagePercent)
        .filter((value): value is number => value !== null) ?? []
    return values.length > 0 ? Math.max(...values) : null
  })

  const warnings = computed<PerformanceWarning[]>(() => {
    const result: PerformanceWarning[] = []
    const current = snapshot.value

    if (lastError.value) {
      result.push({
        id: "system-monitor-unavailable",
        severity: "warning",
        title: "System monitor unavailable",
        message: lastError.value
      })
    }
    if (!current) return result

    const cpuSeverity = highestSeverity([
      classifyUpperBound(
        current.cpu.overallUsagePercent,
        PERFORMANCE_THRESHOLDS.cpu.warningPercent,
        PERFORMANCE_THRESHOLDS.cpu.criticalPercent
      ),
      classifyUpperBound(
        maximumCoreUsagePercent.value,
        PERFORMANCE_THRESHOLDS.cpu.warningPercent,
        PERFORMANCE_THRESHOLDS.cpu.criticalPercent
      )
    ])
    if (cpuSeverity !== "normal") {
      result.push({
        id: "cpu-pressure",
        severity: cpuSeverity,
        title: cpuSeverity === "critical" ? "CPU headroom exhausted" : "CPU headroom is narrowing",
        message: `The busiest core is at ${Math.round(maximumCoreUsagePercent.value ?? 0)}%. Real-time audio may need a larger buffer.`
      })
    }

    const memorySeverity = classifyUpperBound(
      current.memory.usagePercent,
      PERFORMANCE_THRESHOLDS.memory.warningPercent,
      PERFORMANCE_THRESHOLDS.memory.criticalPercent
    )
    if (memorySeverity !== "normal") {
      result.push({
        id: "memory-pressure",
        severity: memorySeverity,
        title: memorySeverity === "critical" ? "Memory pressure is critical" : "Memory use is high",
        message: `${Math.round(current.memory.usagePercent)}% of physical memory is currently in use.`
      })
    }

    for (const space of current.storage) {
      const severity = storageSeverity(space)
      if (severity === "normal") continue
      const label = space.id === "workspace" ? "Workspace" : "Swap"
      result.push({
        id: `${space.id}-storage`,
        severity,
        title:
          space.state === "unavailable"
            ? `${label} storage unavailable`
            : `${label} storage is low`,
        message:
          space.state === "unavailable"
            ? "The configured path could not be measured. Check that the location is mounted and accessible."
            : "Free space has crossed the configured recording safety threshold."
      })
    }

    const audioIpc = current.audioIpc
    if (audioIpc) {
      const heartbeatSeverity = classifyUpperBound(
        audioIpc.heartbeat.ageMs,
        PERFORMANCE_THRESHOLDS.audioIpc.warningHeartbeatAgeMs,
        PERFORMANCE_THRESHOLDS.audioIpc.criticalHeartbeatAgeMs
      )
      if (heartbeatSeverity !== "normal") {
        result.push({
          id: "audio-ipc-heartbeat",
          severity: heartbeatSeverity,
          title:
            heartbeatSeverity === "critical"
              ? "Audio helper heartbeat is stalled"
              : "Audio helper heartbeat is late",
          message: `The priority heartbeat is ${Math.round(audioIpc.heartbeat.ageMs ?? 0)} ms old.`
        })
      }

      const requestUtilization = Math.max(
        utilizationPercent(audioIpc.requests.normalPending, audioIpc.requests.capacity),
        utilizationPercent(audioIpc.requests.priorityPending, audioIpc.requests.capacity),
        utilizationPercent(audioIpc.eventQueueDepth, audioIpc.requests.capacity),
        utilizationPercent(audioIpc.runtime.egressQueueDepth, audioIpc.requests.capacity)
      )
      const requestSeverity = classifyUpperBound(
        requestUtilization,
        PERFORMANCE_THRESHOLDS.audioIpc.warningUtilizationPercent,
        PERFORMANCE_THRESHOLDS.audioIpc.criticalUtilizationPercent
      )
      if (requestSeverity !== "normal") {
        result.push({
          id: "audio-ipc-router-pressure",
          severity: requestSeverity,
          title:
            requestSeverity === "critical"
              ? "Audio IPC router is saturated"
              : "Audio IPC router pressure is high",
          message: `${Math.round(requestUtilization)}% of a request or event queue is occupied.`
        })
      }

      const sharedMemoryUtilization = Math.max(
        utilizationPercent(
          audioIpc.sharedMemory.outstandingLeases,
          audioIpc.sharedMemory.maxLeases
        ),
        utilizationPercent(audioIpc.sharedMemory.outstandingBytes, audioIpc.sharedMemory.maxBytes),
        utilizationPercent(
          audioIpc.sharedMemory.arenaUsedBytes,
          audioIpc.sharedMemory.arenaCapacityBytes
        )
      )
      let sharedMemorySeverity = classifyUpperBound(
        sharedMemoryUtilization,
        PERFORMANCE_THRESHOLDS.audioIpc.warningUtilizationPercent,
        PERFORMANCE_THRESHOLDS.audioIpc.criticalUtilizationPercent
      )
      if (
        sharedMemorySeverity === "normal" &&
        (audioIpc.sharedMemory.arenaBusy > 0 || audioIpc.sharedMemory.arenaQuarantinedRegions > 0)
      ) {
        sharedMemorySeverity = "warning"
      }
      if (sharedMemorySeverity !== "normal") {
        result.push({
          id: "audio-ipc-shared-memory-pressure",
          severity: sharedMemorySeverity,
          title:
            sharedMemorySeverity === "critical"
              ? "Shared-memory leases are saturated"
              : "Shared-memory lease pressure is high",
          message:
            `${Math.round(sharedMemoryUtilization)}% of the shared attachment budget is in use. ` +
            `${audioIpc.sharedMemory.arenaBusy} busy and ` +
            `${audioIpc.sharedMemory.arenaQuarantinedRegions} quarantined events were observed.`
        })
      }

      const parameterRingUtilization = utilizationPercent(
        audioIpc.parameterRing.used,
        audioIpc.parameterRing.capacity
      )
      const parameterRingSeverity = classifyUpperBound(
        parameterRingUtilization,
        PERFORMANCE_THRESHOLDS.audioIpc.warningUtilizationPercent,
        PERFORMANCE_THRESHOLDS.audioIpc.criticalUtilizationPercent
      )
      if (parameterRingSeverity !== "normal") {
        result.push({
          id: "audio-ipc-parameter-ring-pressure",
          severity: parameterRingSeverity,
          title:
            parameterRingSeverity === "critical"
              ? "Parameter command ring is saturated"
              : "Parameter command ring pressure is high",
          message: `${Math.round(parameterRingUtilization)}% of the real-time command ring is occupied.`
        })
      }
    }

    return result
  })

  const severity = computed<HealthSeverity>(() =>
    highestSeverity(warnings.value.map((warning) => warning.severity))
  )

  return {
    snapshot,
    lastError,
    isRefreshing,
    maximumCoreUsagePercent,
    warnings,
    severity,
    refresh,
    startPolling,
    stopPolling
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSystemPerformanceStore, import.meta.hot))
}

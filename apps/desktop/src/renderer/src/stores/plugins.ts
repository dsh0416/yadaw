import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, onScopeDispose, shallowRef } from "vue"
import type {
  PluginCatalogSnapshot,
  PluginDescriptor,
  PluginRuntimeStatus,
  PluginScanEvent
} from "@yadaw/contracts"
import { useMixerStore } from "./mixer"

const EMPTY_CATALOG: PluginCatalogSnapshot = {
  scannerVersion: 1,
  scanning: false,
  scannedAt: null,
  plugins: []
}

export const usePluginStore = defineStore("plugins", () => {
  const mixerStore = useMixerStore()
  const catalog = shallowRef<PluginCatalogSnapshot>(structuredClone(EMPTY_CATALOG))
  const runtime = shallowRef<Record<string, PluginRuntimeStatus>>({})
  const scanProgress = shallowRef<{ completed: number; total: number; path: string } | null>(null)
  const loading = shallowRef(false)
  const error = shallowRef("")
  let unsubscribe: (() => void) | null = null

  const compatibleInstruments = computed(() =>
    catalog.value.plugins.filter((plugin) =>
      plugin.kind === "instrument" && plugin.compatibility === "compatible"
    )
  )
  const compatibleEffects = computed(() =>
    catalog.value.plugins.filter((plugin) =>
      plugin.kind === "effect" && plugin.compatibility === "compatible"
    )
  )
  const quarantined = computed(() =>
    catalog.value.plugins.filter((plugin) => plugin.compatibility === "quarantined")
  )

  function handleScanEvent(event: PluginScanEvent): void {
    if (event.type === "started") {
      catalog.value = { ...catalog.value, scanning: true }
      scanProgress.value = { completed: 0, total: event.total, path: "" }
    } else if (event.type === "progress") {
      scanProgress.value = {
        completed: event.completed,
        total: event.total,
        path: event.path
      }
    } else if (event.type === "completed") {
      catalog.value = event.catalog
      scanProgress.value = null
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = ""
    unsubscribe ??= window.yadaw.subscribePluginScan(handleScanEvent)
    try {
      catalog.value = await window.yadaw.listPlugins()
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to load the plugin catalog."
    } finally {
      loading.value = false
    }
  }

  async function scan(retryQuarantined = false): Promise<void> {
    error.value = ""
    try {
      catalog.value = await window.yadaw.scanPlugins({ retryQuarantined })
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Plugin scan failed."
    }
  }

  async function addInstrument(descriptor: PluginDescriptor): Promise<boolean> {
    let channel = mixerStore.selectedChannel
    const hasInstrument = channel
      ? mixerStore.graph.plugins.some((plugin) =>
          plugin.channelId === channel?.id && plugin.role === "instrument"
        )
      : false
    if (channel?.kind !== "instrument" || hasInstrument) {
      if (!await mixerStore.createInstrumentTrack()) return false
      channel = mixerStore.selectedChannel
    }
    if (!channel || channel.kind !== "instrument") return false
    return mixerStore.execute({
      type: "create-plugin",
      plugin: {
        id: crypto.randomUUID(),
        channelId: channel.id,
        role: "instrument",
        slotOrder: 0,
        classId: descriptor.classId,
        descriptor: structuredClone(descriptor),
        enabled: true,
        componentState: new Uint8Array(),
        controllerState: new Uint8Array()
      }
    })
  }

  function addEffect(descriptor: PluginDescriptor): Promise<boolean> {
    const channel = mixerStore.selectedChannel
    if (!channel || channel.kind === "master") {
      error.value = "Select an Audio, Instrument, Bus, or Output channel first."
      return Promise.resolve(false)
    }
    const slotOrder = mixerStore.graph.plugins.filter((plugin) =>
      plugin.channelId === channel.id && plugin.role === "insert"
    ).length
    return mixerStore.execute({
      type: "create-plugin",
      plugin: {
        id: crypto.randomUUID(),
        channelId: channel.id,
        role: "insert",
        slotOrder,
        classId: descriptor.classId,
        descriptor: structuredClone(descriptor),
        enabled: true,
        componentState: new Uint8Array(),
        controllerState: new Uint8Array()
      }
    })
  }

  function activate(descriptor: PluginDescriptor): Promise<boolean> {
    return descriptor.kind === "instrument"
      ? addInstrument(descriptor)
      : addEffect(descriptor)
  }

  async function openEditor(instanceId: string): Promise<void> {
    try {
      const status = await window.yadaw.openPluginEditor(instanceId)
      runtime.value = { ...runtime.value, [instanceId]: status }
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to open the plugin editor."
    }
  }

  function reset(): void {
    catalog.value = structuredClone(EMPTY_CATALOG)
    runtime.value = {}
    scanProgress.value = null
    error.value = ""
  }

  onScopeDispose(() => {
    unsubscribe?.()
    unsubscribe = null
  })

  return {
    catalog,
    runtime,
    scanProgress,
    loading,
    error,
    compatibleInstruments,
    compatibleEffects,
    quarantined,
    load,
    scan,
    activate,
    addInstrument,
    addEffect,
    openEditor,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePluginStore, import.meta.hot))
}

import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, onScopeDispose, shallowRef, watch } from "vue"
import type {
  PluginCatalogSnapshot,
  PluginDescriptor,
  PluginParameterChange,
  PluginParameterInfo,
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
  const parameters = shallowRef<Record<string, PluginParameterInfo[]>>({})
  const genericPanelId = shallowRef<string | null>(null)
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
  const genericPlugin = computed(() =>
    mixerStore.graph.plugins.find((plugin) => plugin.id === genericPanelId.value) ?? null
  )

  function reconcileRuntime(): void {
    const next = { ...runtime.value }
    for (const instance of mixerStore.graph.plugins) {
      const descriptor = catalog.value.plugins.find((plugin) =>
        plugin.classId === instance.classId && plugin.modulePath === instance.descriptor.modulePath
      )
      if (!descriptor) {
        next[instance.id] = {
          instanceId: instance.id,
          state: "missing",
          editorOpen: false,
          latencySamples: 0,
          tailSamples: 0,
          error: "The saved VST3 module is missing."
        }
      } else if (descriptor.compatibility === "quarantined") {
        next[instance.id] = {
          instanceId: instance.id,
          state: "quarantined",
          editorOpen: false,
          latencySamples: 0,
          tailSamples: 0,
          error: descriptor.compatibilityReason
        }
      }
    }
    runtime.value = next
  }

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
      reconcileRuntime()
    }
  }

  async function load(): Promise<void> {
    loading.value = true
    error.value = ""
    unsubscribe ??= window.yadaw.subscribePluginScan(handleScanEvent)
    try {
      catalog.value = await window.yadaw.listPlugins()
      reconcileRuntime()
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

  function addEffectAt(
    descriptor: PluginDescriptor,
    channelId?: string,
    slotOrder?: number
  ): Promise<boolean> {
    const channel = channelId
      ? mixerStore.graph.channels.find((candidate) => candidate.id === channelId) ?? null
      : mixerStore.selectedChannel
    if (!channel || channel.kind === "master") {
      error.value = "Select an Audio, Instrument, Bus, or Output channel first."
      return Promise.resolve(false)
    }
    const inserts = mixerStore.graph.plugins.filter((plugin) =>
      plugin.channelId === channel.id && plugin.role === "insert"
    )
    const insertionIndex = Math.max(0, Math.min(slotOrder ?? inserts.length, inserts.length))
    const plugin = {
      id: crypto.randomUUID(),
      channelId: channel.id,
      role: "insert" as const,
      slotOrder: inserts.length,
      classId: descriptor.classId,
      descriptor: structuredClone(descriptor),
      enabled: true,
      componentState: new Uint8Array(),
      controllerState: new Uint8Array()
    }
    return mixerStore.execute(insertionIndex === inserts.length ? {
      type: "create-plugin",
      plugin
    } : {
      type: "batch",
      commands: [
        { type: "create-plugin", plugin },
        {
          type: "move-plugin",
          pluginId: plugin.id,
          channelId: channel.id,
          role: "insert",
          slotOrder: insertionIndex
        }
      ]
    })
  }

  function addEffect(descriptor: PluginDescriptor): Promise<boolean> {
    return addEffectAt(descriptor)
  }

  function moveInsert(instanceId: string, channelId: string, slotOrder: number): Promise<boolean> {
    const plugin = mixerStore.graph.plugins.find((candidate) => candidate.id === instanceId)
    if (!plugin || plugin.role !== "insert" || plugin.descriptor.kind !== "effect") {
      error.value = "Only effect insert slots can be reordered."
      return Promise.resolve(false)
    }
    return mixerStore.execute({
      type: "move-plugin",
      pluginId: instanceId,
      channelId,
      role: "insert",
      slotOrder
    })
  }

  function assignInstrument(descriptor: PluginDescriptor, channelId: string): Promise<boolean> {
    const channel = mixerStore.graph.channels.find((candidate) => candidate.id === channelId)
    if (!channel || channel.kind !== "instrument" || descriptor.kind !== "instrument") {
      error.value = "Instruments can only be assigned to Instrument tracks."
      return Promise.resolve(false)
    }
    const current = mixerStore.graph.plugins.find((plugin) =>
      plugin.channelId === channelId && plugin.role === "instrument"
    )
    const plugin = {
      id: current?.id ?? crypto.randomUUID(),
      channelId,
      role: "instrument" as const,
      slotOrder: 0,
      classId: descriptor.classId,
      descriptor: structuredClone(descriptor),
      enabled: true,
      componentState: new Uint8Array(),
      controllerState: new Uint8Array()
    }
    return mixerStore.execute(current
      ? { type: "replace-plugin", pluginId: current.id, plugin }
      : { type: "create-plugin", plugin })
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
      if (!status.editorOpen) {
        genericPanelId.value = instanceId
        parameters.value = {
          ...parameters.value,
          [instanceId]: await window.yadaw.getPluginParameters(instanceId)
        }
      }
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to open the plugin editor."
      genericPanelId.value = instanceId
    }
  }

  async function setParameter(change: PluginParameterChange): Promise<void> {
    const list = parameters.value[change.instanceId]
    if (list) {
      parameters.value = {
        ...parameters.value,
        [change.instanceId]: list.map((parameter) =>
          parameter.id === change.parameterId
            ? { ...parameter, normalized: change.normalized }
            : parameter
        )
      }
    }
    try {
      await window.yadaw.setPluginParameter(change)
    } catch (reason) {
      error.value = reason instanceof Error ? reason.message : "Unable to change the parameter."
    }
  }

  function closeGenericPanel(): void {
    genericPanelId.value = null
  }

  watch(
    () => mixerStore.graph.plugins.map((plugin) => `${plugin.id}:${plugin.classId}`).join("|"),
    reconcileRuntime
  )

  function reset(): void {
    catalog.value = structuredClone(EMPTY_CATALOG)
    runtime.value = {}
    parameters.value = {}
    genericPanelId.value = null
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
    parameters,
    genericPanelId,
    scanProgress,
    loading,
    error,
    compatibleInstruments,
    compatibleEffects,
    quarantined,
    genericPlugin,
    load,
    scan,
    activate,
    addInstrument,
    addEffect,
    addEffectAt,
    moveInsert,
    assignInstrument,
    openEditor,
    setParameter,
    closeGenericPanel,
    reset
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePluginStore, import.meta.hot))
}

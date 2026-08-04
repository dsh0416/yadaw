import type { AudioHostRuntime, NativeEditorToolbarState } from "@heron/dsp-node"
import type {
  AppLocale,
  PluginEditorMode,
  PluginEditorPreference,
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterCommand,
  PluginParameterEnqueueResult,
  PluginParameterInfo,
  PluginStateEnvelope
} from "@heron/contracts"
import { pluginTypeKey } from "@heron/contracts"
import { binaryBytes, inlineBinary } from "./wire"
import type { ControlResponse } from "./wire"
import type { PluginEditorToolbarAction } from "./audio-host-editor-windows"

interface LoadedPlugin {
  typeKey: string
  runtimeHandle: number
  latencySamples: number
  tailSamples: number | null
}

export interface PluginEditorAppearanceWire {
  theme: "light" | "dark"
  locale: AppLocale
}

export interface PluginEditorContextWire {
  channelName: string
  channelColor: string
  pluginName: string
  appearance: PluginEditorAppearanceWire
}

export class AudioHostPluginClient {
  private readonly loadedPlugins = new Map<string, LoadedPlugin>()
  private readonly recoveryBypassed = new Set<string>()
  private readonly coalescedParameters = new Map<
    string,
    {
      targetKind: "plugin" | "mixer-channel" | "mixer-send"
      runtimeHandle: number
      parameterToken: number
      value: number
    }
  >()
  private parameterFlush: NodeJS.Timeout | null = null

  constructor(
    private readonly getClient: () => AudioHostRuntime | null,
    private readonly request: (command: Record<string, unknown>) => Promise<ControlResponse>,
    private readonly requestImmediately: (
      command: Record<string, unknown>
    ) => Promise<ControlResponse>
  ) {}

  status(instanceId: string): LoadedPlugin | undefined {
    return this.loadedPlugins.get(instanceId)
  }

  has(instanceId: string): boolean {
    return this.loadedPlugins.has(instanceId)
  }

  loadedInstanceIds(): string[] {
    return [...this.loadedPlugins.keys()]
  }

  isBypassed(instanceId: string): boolean {
    return this.recoveryBypassed.has(instanceId)
  }

  bypass(instanceId: string): void {
    this.recoveryBypassed.add(instanceId)
  }

  resetConnection(): void {
    this.loadedPlugins.clear()
    this.coalescedParameters.clear()
    if (this.parameterFlush) clearTimeout(this.parameterFlush)
    this.parameterFlush = null
  }

  async loadPlugin(
    plugin: PluginInstanceState,
    sampleRate: number
  ): Promise<{
    latencySamples: number
    tailSamples: number | null
  }> {
    return this.loadPluginWithRequest(plugin, sampleRate, false)
  }

  async loadPluginWithRequest(
    plugin: PluginInstanceState,
    sampleRate: number,
    immediate: boolean
  ): Promise<{
    latencySamples: number
    tailSamples: number | null
  }> {
    const existing = this.loadedPlugins.get(plugin.id)
    if (existing) return existing
    const locator = plugin.locator
    const state = plugin.state
    const response = await (
      immediate ? this.requestImmediately.bind(this) : this.request.bind(this)
    )({
      type: "load-plugin",
      instance_id: plugin.id,
      locator: {
        format: locator.format,
        artifact_path: locator.artifactPath,
        native_id: locator.nativeId
      },
      plugin_kind: plugin.descriptor.kind,
      audio_mode: plugin.audioMode,
      active_aux_inputs: plugin.sidechainInputs.map((route) => {
        const bus = plugin.descriptor.buses.find(
          (candidate) =>
            candidate.direction === "input" &&
            candidate.kind === "aux" &&
            candidate.portKey === route.inputPortKey
        )
        if (!bus || (bus.channels !== 1 && bus.channels !== 2)) {
          throw new Error(`Plugin side-chain port ${route.inputPortKey} is unavailable`)
        }
        return { input_port_key: route.inputPortKey, channels: bus.channels }
      }),
      sample_rate: sampleRate,
      state: {
        version: state.version,
        chunks: state.chunks.map((chunk) => ({ key: chunk.key, bytes: inlineBinary(chunk.bytes) }))
      },
      ara_factory_class_id: plugin.descriptor.ara?.factoryClassId ?? null
    })
    if (response.result.type !== "plugin-loaded") {
      throw new Error("audio host returned an invalid plugin load response")
    }
    const status = {
      typeKey: pluginTypeKey(locator),
      runtimeHandle: response.result.runtime_handle ?? 0,
      latencySamples: response.result.latency_samples ?? 0,
      tailSamples: response.result.tail_samples ?? null
    }
    this.loadedPlugins.set(plugin.id, status)
    return status
  }

  async unloadPlugin(instanceId: string): Promise<void> {
    if (!this.loadedPlugins.has(instanceId)) return
    await this.request({
      type: "unload-plugin",
      instance_id: instanceId
    })
    this.loadedPlugins.delete(instanceId)
    this.recoveryBypassed.delete(instanceId)
  }

  async pluginParameters(instanceId: string): Promise<PluginParameterInfo[]> {
    const response = await this.request({
      type: "plugin-parameters",
      instance_id: instanceId
    })
    if (response.result.type !== "plugin-parameters") {
      throw new Error("audio host returned an invalid parameter response")
    }
    return (response.result.parameters ?? []).map((parameter) => ({
      parameterKey: parameter.parameter_key,
      runtimeToken: parameter.runtime_token,
      title: parameter.title,
      shortTitle: parameter.title,
      units: parameter.units,
      stepCount: parameter.step_count,
      defaultNormalized: parameter.default_normalized,
      normalized: parameter.normalized,
      minValue: parameter.min_value,
      maxValue: parameter.max_value,
      defaultValue: parameter.default_value,
      value: parameter.value,
      normalizedValue: parameter.normalized_value,
      modulePath: parameter.module_path,
      readOnly: parameter.read_only,
      hidden: parameter.hidden,
      stepped: parameter.stepped,
      automatable: parameter.automatable,
      bypass: parameter.bypass,
      ...(parameter.formatted === undefined ? {} : { formatted: parameter.formatted })
    }))
  }

  async openPluginEditor(
    instanceId: string,
    preference: PluginEditorPreference,
    context: PluginEditorContextWire
  ): Promise<{
    editorMode: PluginEditorMode
    open: boolean
  }> {
    const response = await this.request({
      type: "open-plugin-editor",
      instance_id: instanceId,
      preference: {
        mode: preference.mode,
        zoom_percent: preference.zoomPercent
      },
      context: {
        channel_name: context.channelName,
        channel_color: context.channelColor,
        plugin_name: context.pluginName,
        appearance: context.appearance
      }
    })
    if (response.result.type !== "plugin-editor") {
      throw new Error("audio host returned an invalid plugin editor response")
    }
    return {
      editorMode: response.result.active_mode === "native" ? "native" : "parameters",
      open: response.result.open === true
    }
  }

  async configurePluginEditorAppearance(appearance: PluginEditorAppearanceWire): Promise<void> {
    await this.request({
      type: "configure-plugin-editor-appearance",
      appearance
    })
  }

  async applyPluginEditorAction(
    instanceId: string,
    action: PluginEditorToolbarAction
  ): Promise<NativeEditorToolbarState> {
    const response = await this.request({
      type: "apply-plugin-editor-action",
      instance_id: instanceId,
      action
    })
    if (response.result.type !== "plugin-editor-toolbar" || !response.result.state) {
      throw new Error("audio host returned an invalid plug-in editor toolbar response")
    }
    const state = response.result.state
    if ("version" in state) {
      throw new Error("audio host returned plug-in state instead of editor toolbar state")
    }
    return {
      activeMode: state.active_mode,
      zoomPercent: state.zoom_percent,
      compareSlot: state.compare_slot,
      canCompare: state.can_compare,
      canPaste: state.can_paste,
      canUndo: state.can_undo,
      canRedo: state.can_redo,
      sidechainBuses: state.sidechain_buses.map((bus) => ({
        inputPortKey: bus.input_port_key,
        name: bus.name,
        ...(bus.source_channel_id === null ? {} : { sourceChannelId: bus.source_channel_id })
      })),
      sidechainSources: state.sidechain_sources.map((source) => ({
        id: source.id,
        name: source.name,
        kind: source.kind
      })),
      sidechainPending: state.sidechain_pending
    }
  }

  async closePluginEditor(instanceId: string): Promise<void> {
    await this.request({
      type: "close-plugin-editor",
      instance_id: instanceId
    })
  }

  async setPluginParameter(change: PluginParameterChange): Promise<void> {
    await this.request({
      type: "set-plugin-parameter",
      instance_id: change.instanceId,
      parameter_key: change.parameterKey,
      value: change.value,
      gesture: change.gesture
    })
  }

  async enqueuePluginParameter(
    change: PluginParameterCommand
  ): Promise<PluginParameterEnqueueResult> {
    const client = this.getClient()
    const plugin = this.loadedPlugins.get(change.plugin.id)
    if (!client || !plugin?.runtimeHandle) {
      await this.request({
        type: "set-plugin-parameter",
        instance_id: change.plugin.id,
        parameter_key: change.parameterKey,
        value: change.value,
        gesture: change.gesture
      })
      return {
        plugin: change.plugin,
        helperEpoch: change.helperEpoch,
        sequence: change.sequence,
        outcome: "queued"
      }
    }
    const result = client.enqueueParameter({
      targetKind: "plugin",
      runtimeHandle: plugin.runtimeHandle,
      parameterToken: change.runtimeToken,
      value: change.value,
      gesture: change.gesture,
      sequence: change.sequence,
      targetGeneration: change.pluginGeneration
    })
    if (
      (result.outcome === "soft-full" || result.outcome === "full") &&
      change.gesture === "perform"
    ) {
      this.coalesceParameter({
        targetKind: "plugin",
        runtimeHandle: plugin.runtimeHandle,
        parameterToken: change.runtimeToken,
        value: change.value
      })
    }
    return {
      plugin: change.plugin,
      helperEpoch: change.helperEpoch,
      sequence: result.sequence,
      outcome:
        result.outcome === "queued" || result.outcome === "fallback" || result.outcome === "stale"
          ? result.outcome
          : result.outcome === "soft-full" ||
              (result.outcome === "full" && change.gesture === "perform")
            ? "coalesced"
            : "full"
    }
  }

  async savePluginState(instanceId: string): Promise<PluginStateEnvelope> {
    const response = await this.request({
      type: "save-plugin-state",
      instance_id: instanceId
    })
    if (response.result.type !== "plugin-state") {
      throw new Error("audio host returned an invalid plugin state response")
    }
    const state = response.result.state
    if (!state || !("version" in state) || !Array.isArray(state.chunks)) {
      throw new Error("audio host returned an invalid plug-in state envelope")
    }
    return {
      version: 1,
      chunks: state.chunks.map((chunk) => ({ key: chunk.key, bytes: binaryBytes(chunk.bytes) }))
    }
  }

  coalesceParameter(value: {
    targetKind: "plugin" | "mixer-channel" | "mixer-send"
    runtimeHandle: number
    parameterToken: number
    value: number
  }): void {
    const key = `${value.targetKind}:${value.runtimeHandle}:${value.parameterToken}`
    this.coalescedParameters.set(key, value)
    if (this.parameterFlush) return
    this.parameterFlush = setTimeout(() => {
      this.parameterFlush = null
      const client = this.getClient()
      if (!client) return
      const pending = [...this.coalescedParameters.entries()]
      this.coalescedParameters.clear()
      for (const [pendingKey, command] of pending) {
        const result = client.enqueueParameter({
          targetKind: command.targetKind,
          runtimeHandle: command.runtimeHandle,
          parameterToken: command.parameterToken,
          value: command.value,
          gesture: "perform"
        })
        if (result.outcome === "soft-full" || result.outcome === "full") {
          this.coalescedParameters.set(pendingKey, command)
        }
      }
      if (this.coalescedParameters.size > 0) {
        this.coalesceParameter(this.coalescedParameters.values().next().value!)
      }
    }, 4)
    this.parameterFlush.unref()
  }
}

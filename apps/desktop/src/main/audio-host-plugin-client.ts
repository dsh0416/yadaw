import type { AudioHostIpcClient } from "@yadaw/audio-host-client"
import type {
  PluginEditorMode,
  PluginEditorPreference,
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterInfo
} from "@yadaw/contracts"
import { binaryBytes, inlineBinary } from "./audio-host-wire"
import type { ControlResponse } from "./audio-host-wire"

interface LoadedPlugin {
  classId: string
  runtimeHandle: number
  latencySamples: number
  tailSamples: number | null
}

export class AudioHostPluginClient {
  private readonly loadedPlugins = new Map<string, LoadedPlugin>()
  private readonly recoveryBypassed = new Set<string>()
  private readonly coalescedParameters = new Map<
    string,
    {
      targetKind: "plugin" | "mixer-channel" | "mixer-send"
      runtimeHandle: number
      parameterId: number
      normalized: number
    }
  >()
  private parameterFlush: NodeJS.Timeout | null = null

  constructor(
    private readonly getClient: () => AudioHostIpcClient | null,
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
    const response = await (
      immediate ? this.requestImmediately.bind(this) : this.request.bind(this)
    )({
      type: "load-plugin",
      instance_id: plugin.id,
      module_path: plugin.descriptor.modulePath,
      class_id: plugin.classId,
      plugin_kind: plugin.descriptor.kind,
      audio_mode: plugin.audioMode,
      sample_rate: sampleRate,
      component_state: inlineBinary(plugin.componentState),
      controller_state: inlineBinary(plugin.controllerState)
    })
    if (response.result.type !== "plugin-loaded") {
      throw new Error("audio host returned an invalid plugin load response")
    }
    const status = {
      classId: plugin.classId,
      runtimeHandle: response.result.runtime_handle ?? 0,
      latencySamples: response.result.latency_samples ?? 0,
      tailSamples: response.result.tail_samples ?? null
    }
    this.loadedPlugins.set(plugin.id, status)
    return status
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
      id: parameter.id,
      title: parameter.title,
      shortTitle: parameter.title,
      units: parameter.units,
      stepCount: parameter.step_count,
      defaultNormalized: parameter.default_normalized,
      normalized: parameter.normalized,
      flags: parameter.flags
    }))
  }

  async openPluginEditor(
    instanceId: string,
    preference: PluginEditorPreference
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

  async closePluginEditor(instanceId: string): Promise<void> {
    await this.request({
      type: "close-plugin-editor",
      instance_id: instanceId
    })
  }

  async setPluginParameter(change: PluginParameterChange): Promise<void> {
    const client = this.getClient()
    const plugin = this.loadedPlugins.get(change.instanceId)
    if (!client || !plugin?.runtimeHandle) {
      await this.request({
        type: "set-plugin-parameter",
        instance_id: change.instanceId,
        parameter_id: change.parameterId,
        normalized: change.normalized,
        gesture: change.gesture
      })
      return
    }
    const result = client.enqueueParameter(
      "plugin",
      plugin.runtimeHandle,
      change.parameterId,
      change.normalized,
      change.gesture
    )
    if ((result === "soft-full" || result === "full") && change.gesture === "perform") {
      this.coalesceParameter({
        targetKind: "plugin",
        runtimeHandle: plugin.runtimeHandle,
        parameterId: change.parameterId,
        normalized: change.normalized
      })
    }
  }

  async savePluginState(instanceId: string): Promise<{
    componentState: Uint8Array
    controllerState: Uint8Array
  }> {
    const response = await this.request({
      type: "save-plugin-state",
      instance_id: instanceId
    })
    if (response.result.type !== "plugin-state") {
      throw new Error("audio host returned an invalid plugin state response")
    }
    return {
      componentState: binaryBytes(response.result.component_state),
      controllerState: binaryBytes(response.result.controller_state)
    }
  }

  coalesceParameter(value: {
    targetKind: "plugin" | "mixer-channel" | "mixer-send"
    runtimeHandle: number
    parameterId: number
    normalized: number
  }): void {
    const key = `${value.targetKind}:${value.runtimeHandle}:${value.parameterId}`
    this.coalescedParameters.set(key, value)
    if (this.parameterFlush) return
    this.parameterFlush = setTimeout(() => {
      this.parameterFlush = null
      const client = this.getClient()
      if (!client) return
      const pending = [...this.coalescedParameters.entries()]
      this.coalescedParameters.clear()
      for (const [pendingKey, command] of pending) {
        const result = client.enqueueParameter(
          command.targetKind,
          command.runtimeHandle,
          command.parameterId,
          Math.max(0, Math.min(1, command.normalized)),
          "perform"
        )
        if (result === "soft-full" || result === "full") {
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

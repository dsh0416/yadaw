import type {
  PluginEditorMode,
  PluginInstanceState,
  PluginParameterChange,
  PluginParameterInfo,
  PluginRuntimeStatus
} from "@heron/contracts"

export interface PluginRuntime {
  resolveInstance(instanceId: string): Promise<{ plugin: PluginInstanceState; sampleRate: number }>
  load(
    plugin: PluginInstanceState,
    sampleRate: number
  ): Promise<{ latencySamples: number; tailSamples: number | null }>
  parameters(instanceId: string): Promise<PluginParameterInfo[]>
  setParameter(change: PluginParameterChange): Promise<void>
  openEditor(instanceId: string): Promise<{ editorMode: PluginEditorMode; open: boolean }>
  closeEditor(instanceId: string): Promise<void>
}

export class PluginRuntimeService {
  private runtime: PluginRuntime | null = null

  attach(runtime: PluginRuntime): void {
    this.runtime = runtime
  }

  async openEditor(instanceId: string): Promise<PluginRuntimeStatus> {
    if (!this.runtime) throw new Error("The native VST3 runtime is not running")
    const { plugin, sampleRate } = await this.runtime.resolveInstance(instanceId)
    const status = await this.runtime.load(plugin, sampleRate)
    const editor = await this.runtime.openEditor(instanceId)
    return {
      instanceId,
      state: plugin.enabled ? "active" : "bypassed",
      editorOpen: editor.open,
      editorMode: editor.editorMode,
      latencySamples: status.latencySamples,
      tailSamples: status.tailSamples,
      error: null
    }
  }

  async closeEditor(instanceId: string): Promise<void> {
    await this.runtime?.closeEditor(instanceId)
  }

  parameters(instanceId: string): Promise<PluginParameterInfo[]> {
    return this.runtime?.parameters(instanceId) ?? Promise.resolve([])
  }

  async setParameter(change: PluginParameterChange): Promise<void> {
    if (
      !Number.isInteger(change.parameterId) ||
      !Number.isFinite(change.normalized) ||
      change.normalized < 0 ||
      change.normalized > 1
    ) {
      throw new TypeError("Invalid VST3 parameter change")
    }
    if (!this.runtime) throw new Error("The native VST3 runtime is not running")
    await this.runtime.setParameter(change)
  }
}

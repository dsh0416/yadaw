import type { PluginInstanceState, PluginRuntimeStatus } from "@heron/contracts"

export function pluginDisplayState(
  plugin: PluginInstanceState,
  runtime?: PluginRuntimeStatus
): PluginRuntimeStatus["state"] {
  if (!runtime || runtime.state === "active" || runtime.state === "bypassed") {
    return plugin.enabled ? "active" : "bypassed"
  }
  return runtime.state
}

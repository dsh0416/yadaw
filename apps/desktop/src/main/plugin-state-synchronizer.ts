import type { AudioHostService } from "./audio-host-service"
import type { ProjectGraphService } from "./project-graph-service"

type PluginStateAudioHost = Pick<AudioHostService, "loadPlugin" | "savePluginState">
type PluginStateGraph = Pick<ProjectGraphService, "snapshot" | "savePluginStates">

export async function synchronizePluginStatesAtomically(
  audioHost: PluginStateAudioHost,
  projectGraph: PluginStateGraph
): Promise<void> {
  const graph = await projectGraph.snapshot()
  const states = []
  const failures: unknown[] = []
  for (const plugin of graph.plugins) {
    try {
      await audioHost.loadPlugin(plugin, graph.sampleRate)
      const state = await audioHost.savePluginState(plugin.id)
      states.push({
        id: plugin.id,
        componentState: state.componentState,
        controllerState: state.controllerState,
        araDocumentState: state.araDocumentState
      })
    } catch (error) {
      console.error(`Could not synchronize VST3 state for ${plugin.id}:`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Could not synchronize every VST3 plug-in state")
  }
  if (states.length > 0) await projectGraph.savePluginStates(states)
}

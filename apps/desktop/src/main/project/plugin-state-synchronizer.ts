import type { AudioHostService } from "../audio-host"
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
        state
      })
    } catch (error) {
      console.error(`Could not synchronize AudioPlugin state for ${plugin.id}:`, error)
      failures.push(error)
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "Could not synchronize every audio plug-in state")
  }
  if (states.length > 0) await projectGraph.savePluginStates(states)
}

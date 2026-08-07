import type { ApplicationServices, IpcHandlerContext } from "./context"
import { registerAudioHandlers } from "./audio-handlers"
import { registerBounceHandlers } from "./bounce-handlers"
import { registerDiagnosticHandlers } from "./diagnostic-handlers"
import { registerMidiHandlers } from "./midi-handlers"
import { registerLowLatencyHandlers } from "./low-latency-handlers"
import { registerMixerHandlers } from "./mixer-handlers"
import { registerPluginHandlers } from "./plugin-handlers"
import { registerProjectHandlers } from "./project-handlers"
import { registerRecordingHandlers } from "./recording-handlers"
import { registerSettingsRpcHandlers } from "./settings-rpc-handlers"
import { registerSystemHandlers } from "./system-handlers"
import { registerTransportHandlers } from "./transport-handlers"
import { sampleSystemPerformance } from "./support"
import { ProjectLifecycleService, synchronizePluginStatesAtomically } from "../project"
import { registerIpcEventPublishers, type DisposableRegistration } from "./event-publishers"

export function registerIpcHandlers(services: ApplicationServices): DisposableRegistration {
  const { audioHost, projectGraph, settings } = services
  const eventPublishers = registerIpcEventPublishers(services)
  try {
    const synchronizePluginStates = (): Promise<void> =>
      synchronizePluginStatesAtomically(audioHost, projectGraph)
    const context: IpcHandlerContext = {
      ...services,
      projectLifecycle: new ProjectLifecycleService(
        services.projects,
        services.projectGraph,
        services.lifecycle,
        services.operations,
        services.settings,
        services.waveforms
      ),
      synchronizePluginStates,
      sampleSystemPerformance: () => sampleSystemPerformance(settings, audioHost)
    }
    registerSystemHandlers(context)
    registerAudioHandlers(context)
    registerBounceHandlers(context)
    registerMixerHandlers(context)
    registerPluginHandlers(context)
    registerMidiHandlers(context)
    registerLowLatencyHandlers(context)
    registerTransportHandlers(context)
    registerDiagnosticHandlers(context)
    registerSettingsRpcHandlers(context)
    registerProjectHandlers(context)
    registerRecordingHandlers(context)
    return eventPublishers
  } catch (error) {
    eventPublishers.dispose()
    throw error
  }
}

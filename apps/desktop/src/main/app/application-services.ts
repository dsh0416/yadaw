import { AssetMaterializer } from "../project"
import { AudioGraphCompiler } from "../project"
import { AudioGraphPublisher } from "../project"
import { bindAudioHostApplicationEvents } from "./audio-host-application-events"
import type { ApplicationEventTarget } from "./audio-host-application-events"
import type { AudioHostService } from "../audio-host"
import type { ApplicationSettingsStore } from "../settings"
import { commitExternalProjectDirty } from "../project"
import { LifecycleCoordinator } from "../kernel"
import { MidiImportService } from "../project"
import { MixerRuntimeService } from "../audio"
import { OperationRegistry } from "../kernel"
import { OperationService } from "../kernel"
import type { PluginCatalogService } from "../plugins"
import { ProjectCommandService } from "../project"
import { ProjectGraphService } from "../project"
import type { ProjectService } from "../project"
import { RecordingService } from "../recording"
import { TransportService } from "../audio"
import { normalizeAudioRuntime } from "../ipc"
import { WaveformService } from "../project"

export interface ApplicationServices {
  projectGraph: ProjectGraphService
  projectCommands: ProjectCommandService
  mixerRuntime: MixerRuntimeService
  transport: TransportService
  midiImport: MidiImportService
  lifecycle: LifecycleCoordinator
  operations: OperationService
  recordings: RecordingService
  waveforms: WaveformService
  dispose(): void
}

export interface CreateApplicationServicesOptions {
  userDataPath: string
  sourceEpoch: string
  settings: ApplicationSettingsStore
  projectService: ProjectService
  audioHost: AudioHostService
  plugins: PluginCatalogService
  eventTargets: () => readonly ApplicationEventTarget[]
  allowRecordingWithoutAudio: boolean
}

export async function createApplicationServices(
  options: CreateApplicationServicesOptions
): Promise<ApplicationServices> {
  const { settings, projectService, audioHost, plugins } = options
  const graphPublisher = new AudioGraphPublisher(
    new AudioGraphCompiler(),
    new AssetMaterializer(options.userDataPath, projectService),
    audioHost,
    plugins,
    settings
  )
  const projectGraph = new ProjectGraphService(projectService, graphPublisher)
  const projectCommands = new ProjectCommandService(
    projectGraph,
    projectService,
    audioHost,
    plugins
  )
  const mixerRuntime = new MixerRuntimeService(audioHost)
  const transport = new TransportService(projectService, audioHost)

  plugins.attachRuntime({
    resolveInstance: async (instanceId) => {
      const graph = await projectGraph.snapshot()
      const plugin = graph.plugins.find((candidate) => candidate.id === instanceId)
      if (!plugin) throw new Error(`Plugin instance '${instanceId}' was not found`)
      return { plugin, sampleRate: graph.sampleRate }
    },
    load: (plugin, sampleRate) => audioHost.loadPlugin(plugin, sampleRate),
    parameters: (instanceId) => audioHost.pluginParameters(instanceId),
    setParameter: (change) => audioHost.setPluginParameter(change),
    openEditor: async (instanceId) => {
      const graph = await projectGraph.snapshot()
      const plugin = graph.plugins.find((candidate) => candidate.id === instanceId)
      if (!plugin) throw new Error(`Plugin instance '${instanceId}' was not found`)
      const channel = graph.channels.find((candidate) => candidate.id === plugin.channelId)
      if (!channel) throw new Error(`Plugin channel '${plugin.channelId}' was not found`)
      const preference = await settings.pluginEditorPreference(plugin.classId)
      return audioHost.openPluginEditor(instanceId, preference, {
        channelName: channel.name,
        channelColor: channel.color,
        pluginName: plugin.descriptor.name,
        appearance: audioHost.pluginEditorAppearanceSnapshot()
      })
    },
    closeEditor: (instanceId) => audioHost.closePluginEditor(instanceId)
  })

  const midiImport = new MidiImportService(projectGraph, projectCommands, plugins)
  const initialAudioRuntime = await audioHost.audioEngineSnapshot()
  const normalizedAudioRuntime = normalizeAudioRuntime(initialAudioRuntime)
  const lifecycle = new LifecycleCoordinator(projectService.current, normalizedAudioRuntime, {
    allowRecordingWithoutAudio: options.allowRecordingWithoutAudio,
    audioHostEpoch: audioHost.helperEpoch() ?? undefined
  })
  if (initialAudioRuntime.state === "running") {
    await lifecycle.applicationState.commitAudioEngine(normalizedAudioRuntime)
  }
  const operations = new OperationService(
    new OperationRegistry(),
    lifecycle.applicationState.desktopSession
  )
  projectCommands.attachKernel(lifecycle, operations)
  const applicationEvents = bindAudioHostApplicationEvents({
    audioHost,
    projectCommands,
    plugins,
    sourceEpoch: options.sourceEpoch,
    targets: options.eventTargets,
    markProjectDirty: () => commitExternalProjectDirty(projectService, lifecycle)
  })
  const recordings = new RecordingService(
    settings,
    projectService,
    operations,
    projectGraph,
    transport,
    audioHost,
    projectCommands
  )
  const waveforms = new WaveformService(settings, projectService)

  return {
    projectGraph,
    projectCommands,
    mixerRuntime,
    transport,
    midiImport,
    lifecycle,
    operations,
    recordings,
    waveforms,
    dispose: () => applicationEvents.dispose()
  }
}

import { app, BrowserWindow, nativeTheme } from "electron"
import { basename, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import { ApplicationSettingsStore } from "./application-settings"
import { AssetMaterializer } from "./asset-materializer"
import { AudioGraphCompiler } from "./audio-graph-compiler"
import { AudioGraphPublisher } from "./audio-graph-publisher"
import { AudioHostService } from "./audio-host-service"
import { installApplicationMenu } from "./application-menu"
import { setMainLocale, t } from "./i18n"
import { LifecycleCoordinator } from "./lifecycle-coordinator"
import { MidiImportService } from "./midi-import-service"
import { MixerRuntimeService } from "./mixer-runtime-service"
import { OperationService } from "./operation-service"
import { OperationRegistry } from "./kernel/operation-registry"
import { PluginCatalogService } from "./plugin-catalog-service"
import { ProjectCommandService } from "./project-command-service"
import { ProjectGraphService } from "./project-graph-service"
import { ProjectService } from "./project-service"
import { RecordingService } from "./recording-service"
import { StartupProgress } from "./startup-progress"
import { WaveformService } from "./waveform-service"
import { TransportService } from "./transport-service"
import { registerIpcHandlers } from "./ipc/register"
import { normalizeAudioRuntime } from "./ipc/support"
import { applicationIconPath } from "./runtime-paths"
import {
  createMainWindow,
  createSplashWindow,
  loadMainWindow,
  mainWindow,
  setWindowProjectService,
  splashWindow
} from "./windows"

export interface StartedApplicationServices {
  audioHostService: AudioHostService
  projectService: ProjectService
}

export function startApplication(
  isShuttingDown: () => boolean,
  onServices: (services: StartedApplicationServices) => void
): void {
  void app.whenReady().then(async () => {
    if (!app.isPackaged) app.dock?.setIcon(applicationIconPath)
    const settings = new ApplicationSettingsStore(app.getPath("userData"))
    const applicationSettings = await settings.get()
    setMainLocale(applicationSettings.locale)

    const startup = new StartupProgress()
    const startupEpoch = randomUUID()
    let startupSequence = 0
    const publishStartupProgress = (progress: ReturnType<StartupProgress["snapshot"]>): void => {
      startupSequence += 1
      const window = splashWindow
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.startupProgressEvent, {
          protocolVersion: IPC_PROTOCOL_VERSION,
          sourceEpoch: startupEpoch,
          sequence: startupSequence,
          resourceRevision: startupSequence,
          payload: progress
        })
      }
    }
    startup.subscribe(publishStartupProgress)
    const splash = createSplashWindow()
    splash.webContents.once("did-finish-load", () => {
      publishStartupProgress(startup.snapshot())
    })

    try {
      startup.update({
        phase: "loading-catalog",
        progress: 0.05,
        label: t("startup.loadingCatalog"),
        detail: t("startup.loadingCatalogDetail")
      })
      const executableSuffix = process.platform === "win32" ? ".exe" : ""
      const probePath = app.isPackaged
        ? join(process.resourcesPath, `yadaw-vst3-probe${executableSuffix}`)
        : resolve(
            app.getAppPath(),
            "..",
            "..",
            "target",
            "debug",
            `yadaw-vst3-probe${executableSuffix}`
          )
      const builtinPluginDirectory = app.isPackaged
        ? join(process.resourcesPath, "plugins")
        : resolve(app.getAppPath(), "..", "..", "target", "bundles")
      const plugins = new PluginCatalogService(
        app.getPath("userData"),
        probePath,
        builtinPluginDirectory
      )
      await plugins.initialize()

      let scanTotal = 0
      let scanWarnings = 0
      const unsubscribeScan = plugins.subscribe((event) => {
        if (event.type === "started") {
          scanTotal = event.total
          startup.update({
            phase: "scanning-plugins",
            progress: 0.16,
            label: t("startup.scanningPlugins"),
            detail:
              event.total === 0
                ? t("startup.noBundles")
                : t("startup.foundBundles", { count: event.total }),
            completed: 0,
            total: event.total
          })
        } else if (event.type === "progress") {
          const ratio = event.total > 0 ? event.completed / event.total : 1
          startup.update({
            phase: "scanning-plugins",
            progress: 0.18 + ratio * 0.58,
            label: t("startup.scanningPlugins"),
            detail: basename(event.path),
            completed: event.completed,
            total: event.total
          })
        } else if (event.type === "quarantined") {
          scanWarnings += 1
          startup.update({
            detail: t("startup.quarantined", { name: basename(event.path) }),
            warnings: scanWarnings
          })
        } else {
          startup.update({
            progress: 0.78,
            detail: t("startup.pluginsAvailable", { count: event.catalog.plugins.length }),
            completed: scanTotal,
            total: scanTotal
          })
        }
      })
      startup.update({
        phase: "scanning-plugins",
        progress: 0.12,
        label: t("startup.discoveringPlugins"),
        detail: t("startup.discoveringPluginsDetail")
      })
      try {
        // Soft discovery (moduleinfo / factory enum) must finish before the
        // workspace opens so project restore can resolve plug-in descriptors.
        // Fingerprint-cached descriptors are reused; quarantined modules retry.
        await plugins.scan({ retryQuarantined: true })
      } catch (error) {
        scanWarnings += 1
        startup.update({
          progress: 0.78,
          detail:
            error instanceof Error
              ? t("startup.scanError", { message: error.message })
              : t("startup.scanUnknownError"),
          warnings: scanWarnings
        })
        console.error("Startup VST3 scan failed:", error)
      } finally {
        unsubscribeScan()
      }

      startup.update({
        phase: "starting-audio",
        progress: 0.82,
        label: t("startup.startingAudio"),
        detail: t("startup.startingAudioDetail"),
        completed: null,
        total: null
      })
      const audioHostPath = app.isPackaged
        ? join(process.resourcesPath, `yadaw-audio-host${executableSuffix}`)
        : resolve(
            app.getAppPath(),
            "..",
            "..",
            "target",
            "debug",
            `yadaw-audio-host${executableSuffix}`
          )
      const window = createMainWindow(false)
      let editorClosedSequence = 0
      const audioHostService = new AudioHostService(
        audioHostPath,
        join(app.getPath("userData"), "audio-host-crash-marker.bin"),
        applicationSettings.audioHostRuntime,
        process.platform === "win32" ? window.getNativeWindowHandle() : undefined,
        (message) => {
          console.error(`YADAW audio helper failure: ${message}`)
          for (const candidate of BrowserWindow.getAllWindows()) {
            if (candidate !== mainWindow && candidate !== splashWindow) candidate.close()
          }
        },
        async (classId, preference) => {
          await settings.setPluginEditorPreference(classId, preference)
        },
        (instanceId) => {
          editorClosedSequence += 1
          const epoch = audioHostService.helperEpoch() ?? "0"
          for (const candidate of BrowserWindow.getAllWindows()) {
            candidate.webContents.send(IPC_CHANNELS.pluginEditorClosedEvent, {
              protocolVersion: IPC_PROTOCOL_VERSION,
              sourceEpoch: epoch,
              sequence: editorClosedSequence,
              resourceRevision: editorClosedSequence,
              payload: { instanceId }
            })
          }
        }
      )
      audioHostService.start()
      await audioHostService.configurePluginEditorAppearance({
        theme:
          applicationSettings.theme === "system"
            ? nativeTheme.shouldUseDarkColors
              ? "dark"
              : "light"
            : applicationSettings.theme,
        locale: applicationSettings.locale
      })
      await audioHostService.configureMidiInput(
        applicationSettings.midiSync,
        applicationSettings.shortcuts
      )
      const projectService = new ProjectService(app.getPath("userData"), settings)
      let araUiSequence = 0
      audioHostService.setAraCallbackHandler(async (callback) => {
        if (
          callback.event.kind === "content-changed" ||
          callback.event.kind === "document-data-changed"
        ) {
          await projectService.markExternalStateDirty()
        }
        if (
          callback.event.kind === "analysis-progress" ||
          callback.event.kind === "archive-progress" ||
          callback.event.kind === "quarantined"
        ) {
          const epoch = audioHostService.helperEpoch() ?? "0"
          araUiSequence += 1
          for (const candidate of BrowserWindow.getAllWindows()) {
            candidate.webContents.send(IPC_CHANNELS.araCallbackEvent, {
              protocolVersion: IPC_PROTOCOL_VERSION,
              sourceEpoch: epoch,
              sequence: araUiSequence,
              resourceRevision: araUiSequence,
              payload: {
                instanceId: callback.instanceId,
                callbackSequence: callback.sequence,
                event: callback.event
              }
            })
          }
        }
      })
      setWindowProjectService(projectService)
      onServices({ audioHostService, projectService })
      const graphPublisher = new AudioGraphPublisher(
        new AudioGraphCompiler(),
        new AssetMaterializer(app.getPath("userData"), projectService),
        audioHostService,
        plugins,
        settings
      )
      const projectGraph = new ProjectGraphService(projectService, graphPublisher)
      const projectCommands = new ProjectCommandService(
        projectGraph,
        projectService,
        audioHostService
      )
      const mixerRuntime = new MixerRuntimeService(audioHostService)
      const transport = new TransportService(projectService, audioHostService)
      plugins.attachRuntime({
        resolveInstance: async (instanceId) => {
          const graph = await projectGraph.snapshot()
          const plugin = graph.plugins.find((candidate) => candidate.id === instanceId)
          if (!plugin) throw new Error(`Plugin instance '${instanceId}' was not found`)
          return { plugin, sampleRate: graph.sampleRate }
        },
        load: (plugin, sampleRate) => {
          if (!audioHostService) return Promise.reject(new Error("Audio host is not running"))
          return audioHostService.loadPlugin(plugin, sampleRate)
        },
        parameters: (instanceId) => {
          if (!audioHostService) return Promise.resolve([])
          return audioHostService.pluginParameters(instanceId)
        },
        setParameter: (change) => {
          if (!audioHostService) return Promise.reject(new Error("Audio host is not running"))
          return audioHostService.setPluginParameter(change)
        },
        openEditor: async (instanceId) => {
          if (!audioHostService) {
            return { editorMode: "parameters" as const, open: false }
          }
          const graph = await projectGraph.snapshot()
          const plugin = graph.plugins.find((candidate) => candidate.id === instanceId)
          if (!plugin) throw new Error(`Plugin instance '${instanceId}' was not found`)
          const channel = graph.channels.find((candidate) => candidate.id === plugin.channelId)
          if (!channel) throw new Error(`Plugin channel '${plugin.channelId}' was not found`)
          const preference = await settings.pluginEditorPreference(plugin.classId)
          return audioHostService.openPluginEditor(instanceId, preference, {
            channelName: channel.name,
            channelColor: channel.color,
            pluginName: plugin.descriptor.name,
            appearance: audioHostService.pluginEditorAppearanceSnapshot()
          })
        },
        closeEditor: (instanceId) => {
          if (!audioHostService) return Promise.resolve()
          return audioHostService.closePluginEditor(instanceId)
        }
      })
      audioHostService.setVst3HostNotificationHandler(async (notification) => {
        if (notification.kind === "dirty-changed" && notification.value === "true") {
          await projectService.markExternalStateDirty()
        } else if (notification.kind === "open-editor") {
          await plugins.openEditor(notification.instanceId)
        }
      })
      const midiImport = new MidiImportService(projectGraph, projectCommands, plugins)
      const initialAudioRuntime = await audioHostService.audioEngineSnapshot()
      const lifecycle = new LifecycleCoordinator(
        projectService.current,
        normalizeAudioRuntime(initialAudioRuntime),
        {
          allowRecordingWithoutAudio: process.env.YADAW_TEST_CAPTURE_SOURCE === "1",
          audioHostEpoch: audioHostService.helperEpoch() ?? undefined
        }
      )
      if (initialAudioRuntime.state === "running") {
        await lifecycle.applicationState.commitAudioEngine(
          normalizeAudioRuntime(initialAudioRuntime)
        )
      }
      const operations = new OperationService(
        new OperationRegistry(),
        lifecycle.applicationState.desktopSession
      )
      projectCommands.attachKernel(lifecycle, operations)
      const recordings = new RecordingService(
        settings,
        projectService,
        operations,
        projectGraph,
        transport,
        audioHostService,
        projectCommands
      )
      const waveforms = new WaveformService(settings, projectService)
      registerIpcHandlers({
        settings,
        projects: projectService,
        recordings,
        operations,
        waveforms,
        projectGraph,
        projectCommands,
        mixerRuntime,
        transport,
        plugins,
        midiImport,
        lifecycle,
        audioHost: audioHostService,
        isShuttingDown
      })
      startup.update({
        phase: "opening-workspace",
        progress: 0.94,
        label: t("startup.openingWorkspace"),
        detail: t("startup.openingWorkspaceDetail")
      })
      window.once("ready-to-show", () => {
        startup.complete(t("startup.pluginsReady", { count: plugins.list().plugins.length }))
        if (!window.isDestroyed()) window.show()
        setTimeout(() => {
          const splash = splashWindow
          if (splash && !splash.isDestroyed()) splash.close()
        }, 220)
      })
      loadMainWindow(window)
      installApplicationMenu(process.platform, applicationSettings.shortcuts)

      app.on("activate", () => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createMainWindow()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      })
    } catch (error) {
      console.error("YADAW startup failed:", error)
      startup.fail(error)
      setTimeout(() => app.quit(), 4_000).unref()
    }
  })
}

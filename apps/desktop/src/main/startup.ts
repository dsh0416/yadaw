import { app, BrowserWindow, ipcMain } from "electron"
import { join, resolve } from "node:path"
import { IPC_CHANNELS } from "@yadaw/contracts"
import { ApplicationSettingsStore } from "./application-settings"
import { AudioHostService } from "./audio-host-service"
import { installApplicationMenu } from "./application-menu"
import { setMainLocale, t } from "./i18n"
import { LifecycleCoordinator } from "./lifecycle-coordinator"
import { MidiImportService } from "./midi-import-service"
import { MixerService } from "./mixer-service"
import { OperationService } from "./operation-service"
import { PluginCatalogService } from "./plugin-catalog-service"
import { ProjectService } from "./project-service"
import { RecordingService } from "./recording-service"
import { StartupProgress } from "./startup-progress"
import { WaveformService } from "./waveform-service"
import { registerIpcHandlers } from "./ipc/register"
import { assertTrustedSender, normalizeAudioRuntime } from "./ipc/support"
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
    const settings = new ApplicationSettingsStore(app.getPath("userData"))
    const applicationSettings = await settings.get()
    setMainLocale(applicationSettings.locale)

    const startup = new StartupProgress()
    ipcMain.handle(IPC_CHANNELS.startupProgressSnapshot, (event) => {
      assertTrustedSender(event)
      return startup.snapshot()
    })
    startup.subscribe((progress) => {
      const window = splashWindow
      if (window && !window.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.startupProgressEvent, progress)
      }
    })
    createSplashWindow()

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
      const cachedPluginCount = plugins.list().plugins.length
      startup.update({
        phase: "scanning-plugins",
        progress: 0.18,
        label: t("startup.discoveringPlugins"),
        detail:
          cachedPluginCount > 0
            ? t("startup.pluginsAvailable", { count: cachedPluginCount })
            : t("startup.discoveringPluginsDetail"),
        completed: null,
        total: null
      })

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
        }
      )
      audioHostService.start()
      const projectService = new ProjectService(app.getPath("userData"), settings)
      setWindowProjectService(projectService)
      onServices({ audioHostService, projectService })
      const operations = new OperationService()
      const mixer = new MixerService(
        app.getPath("userData"),
        projectService,
        audioHostService,
        plugins,
        settings
      )
      plugins.attachRuntime({
        resolveInstance: async (instanceId) => {
          const graph = await mixer.snapshot()
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
          const graph = await mixer.snapshot()
          const plugin = graph.plugins.find((candidate) => candidate.id === instanceId)
          if (!plugin) throw new Error(`Plugin instance '${instanceId}' was not found`)
          const preference = await settings.pluginEditorPreference(plugin.classId)
          return audioHostService.openPluginEditor(instanceId, preference)
        },
        closeEditor: (instanceId) => {
          if (!audioHostService) return Promise.resolve()
          return audioHostService.closePluginEditor(instanceId)
        }
      })
      const midiImport = new MidiImportService(mixer, plugins)
      const recordings = new RecordingService(
        settings,
        projectService,
        operations,
        mixer,
        audioHostService
      )
      const waveforms = new WaveformService(settings, projectService)
      const initialAudioRuntime = await audioHostService.audioEngineSnapshot()
      const lifecycle = new LifecycleCoordinator(
        projectService.current,
        normalizeAudioRuntime(initialAudioRuntime),
        { allowRecordingWithoutAudio: process.env.YADAW_TEST_CAPTURE_SOURCE === "1" }
      )
      registerIpcHandlers(
        settings,
        projectService,
        recordings,
        operations,
        waveforms,
        mixer,
        plugins,
        midiImport,
        lifecycle,
        audioHostService,
        isShuttingDown
      )
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
        // Catalog discovery runs after the workspace is shown. It prefers
        // moduleinfo.json / soft factory enumeration and never deep-loads
        // processors, so large plugin libraries do not block startup.
        void plugins.scan({ retryQuarantined: true }).catch((error: unknown) => {
          console.error("Background VST3 scan failed:", error)
        })
      })
      loadMainWindow(window)
      installApplicationMenu()

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

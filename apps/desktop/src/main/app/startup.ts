import { app, BrowserWindow, nativeTheme } from "electron"
import { basename, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import { ApplicationSettingsStore } from "../settings"
import { createApplicationServices } from "./application-services"
import { AudioHostService } from "../audio-host"
import { installApplicationMenu } from "./application-menu"
import { setMainLocale, t } from "../settings"
import { PluginCatalogService } from "../plugins"
import { ProjectService } from "../project"
import { StartupProgress } from "./startup-progress"
import { registerIpcHandlers } from "../ipc"
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
        ? join(process.resourcesPath, `heron-vst3-probe${executableSuffix}`)
        : resolve(
            app.getAppPath(),
            "..",
            "..",
            "target",
            "debug",
            `heron-vst3-probe${executableSuffix}`
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
        ? join(process.resourcesPath, `heron-audio-host${executableSuffix}`)
        : resolve(
            app.getAppPath(),
            "..",
            "..",
            "target",
            "debug",
            `heron-audio-host${executableSuffix}`
          )
      const window = createMainWindow(false)
      let editorClosedSequence = 0
      const audioHostService = new AudioHostService(
        audioHostPath,
        join(app.getPath("userData"), "audio-host-crash-marker.bin"),
        applicationSettings.audioHostRuntime,
        process.platform === "win32" ? window.getNativeWindowHandle() : undefined,
        (message) => {
          console.error(`Heron audio helper failure: ${message}`)
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
      setWindowProjectService(projectService)
      onServices({ audioHostService, projectService })
      const services = await createApplicationServices({
        userDataPath: app.getPath("userData"),
        sourceEpoch: startupEpoch,
        settings,
        projectService,
        audioHost: audioHostService,
        plugins,
        eventTargets: () => BrowserWindow.getAllWindows(),
        allowRecordingWithoutAudio: process.env.HERON_TEST_CAPTURE_SOURCE === "1"
      })
      registerIpcHandlers({
        settings,
        projects: projectService,
        recordings: services.recordings,
        operations: services.operations,
        waveforms: services.waveforms,
        projectGraph: services.projectGraph,
        projectCommands: services.projectCommands,
        mixerRuntime: services.mixerRuntime,
        transport: services.transport,
        plugins,
        midiImport: services.midiImport,
        lifecycle: services.lifecycle,
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
      console.error("Heron startup failed:", error)
      startup.fail(error)
      setTimeout(() => app.quit(), 4_000).unref()
    }
  })
}

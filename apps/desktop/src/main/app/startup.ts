import { app, BrowserWindow, nativeTheme } from "electron"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { IPC_CHANNELS, IPC_PROTOCOL_VERSION } from "@heron/contracts"
import { ApplicationSettingsStore } from "../settings"
import { createApplicationServices } from "./application-services"
import { AudioHostService, ElectronPluginEditorWindows } from "../audio-host"
import { installApplicationMenu } from "./application-menu"
import { setMainLocale, t } from "../settings"
import { PluginCatalogService } from "../plugins"
import { ProjectService } from "../project"
import { StartupProgress } from "./startup-progress"
import { registerIpcHandlers } from "../ipc"
import { applicationIconPath } from "./runtime-paths"
import { PluginStartupScanCoordinator } from "./plugin-startup-scan-coordinator"
import { denyChromiumPermissions, installRendererProtocol } from "./renderer-security"
import {
  createStartedApplicationServices,
  type StartedApplicationServices
} from "./started-application-services"
import {
  createMainWindow,
  createSplashWindow,
  loadMainWindow,
  mainWindow,
  setWindowProjectService,
  splashWindow
} from "./windows"

export type { StartedApplicationServices } from "./started-application-services"

export function startApplication(
  isShuttingDown: () => boolean,
  onServices: (services: StartedApplicationServices) => void
): void {
  void app.whenReady().then(async () => {
    installRendererProtocol()
    denyChromiumPermissions()
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

      const scanProgress = new PluginStartupScanCoordinator(startup)
      const unsubscribeScan = plugins.subscribe((event) => scanProgress.handle(event))
      startup.update({
        phase: "scanning-plugins",
        progress: 0.12,
        label: t("startup.discoveringPlugins"),
        detail: t("startup.discoveringPluginsDetail")
      })
      try {
        // Catalog-only discovery (moduleinfo / soft factory enum) must finish
        // before the workspace opens. Full bus/layout probing is deferred until
        // a plug-in is about to be loaded into the runtime.
        // Fingerprint-cached descriptors are reused; quarantined modules retry.
        await plugins.scan({ retryQuarantined: true })
      } catch (error) {
        scanProgress.fail(error)
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
      const window = createMainWindow(false)
      const editorWindows = new ElectronPluginEditorWindows(window)
      let editorClosedSequence = 0
      const audioHostService = new AudioHostService(
        applicationSettings.audioHostRuntime,
        undefined,
        (message) => {
          console.error(`Heron embedded audio runtime failure: ${message}`)
          void editorWindows.closeAll()
          for (const candidate of BrowserWindow.getAllWindows()) {
            if (candidate !== mainWindow && candidate !== splashWindow) candidate.close()
          }
        },
        async (pluginTypeKey, preference) => {
          await settings.setPluginEditorPreference(pluginTypeKey, preference)
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
        },
        editorWindows
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
      const ipcRegistration = registerIpcHandlers({
        settings,
        projects: projectService,
        recordings: services.recordings,
        operations: services.operations,
        waveforms: services.waveforms,
        projectGraph: services.projectGraph,
        projectCommands: services.projectCommands,
        mixerRuntime: services.mixerRuntime,
        transport: services.transport,
        audioImport: services.audioImport,
        assetAudition: services.assetAudition,
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

      const handleActivate = (): void => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createMainWindow()
        } else {
          mainWindow.show()
          mainWindow.focus()
        }
      }
      app.on("activate", handleActivate)
      onServices(
        createStartedApplicationServices(audioHostService, projectService, [
          {
            dispose(): void {
              app.removeListener("activate", handleActivate)
              setWindowProjectService(null)
            }
          },
          ipcRegistration,
          services
        ])
      )
    } catch (error) {
      console.error("Heron startup failed:", error)
      startup.fail(error)
      setTimeout(() => app.quit(), 4_000).unref()
    }
  })
}

import {
  app,
  BrowserWindow,
  shell,
  type BrowserWindowConstructorOptions,
  type WebPreferences
} from "electron"
import { join } from "node:path"
import { deferProjectClose } from "./dirty-project-close"
import type { ProjectService } from "../project"
import { applicationIconPath } from "./runtime-paths"
import { resolveRendererEntrypoints } from "../../shared/renderer-security"

const EXTERNAL_URL_ALLOWLIST = new Set([
  "https://github.com/minori-live/heron",
  "https://heron.minori.live/manual/"
])

let projectService: ProjectService | null = null

export function setWindowProjectService(service: ProjectService | null): void {
  projectService = service
}

export let mainWindow: BrowserWindow | null = null
export let splashWindow: BrowserWindow | null = null

export function mainWindowPlatformOptions(
  platform: NodeJS.Platform
): BrowserWindowConstructorOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 12, y: 11 },
      // Native VST3 editors are owned by the embedded audio runtime. Once one
      // becomes active, the next mixer click must both reactivate Electron and
      // reach its control instead of being consumed by AppKit activation.
      acceptFirstMouse: true
    }
  }
  if (platform === "linux") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        color: "#151515",
        symbolColor: "#e8e8e8",
        height: 38
      }
    }
  }
  return { titleBarStyle: "hidden" }
}

export function openExternalUrl(url: string): boolean {
  if (!EXTERNAL_URL_ALLOWLIST.has(url)) return false
  void shell.openExternal(url).catch((error: unknown) => {
    console.error("Heron could not open an external URL", error)
  })
  return true
}

export function loadMainWindow(window: BrowserWindow): void {
  const entrypoints = resolveRendererEntrypoints(app.isPackaged, process.env.HERON_RENDERER_URL)
  void window.loadURL(entrypoints.main)
}

export function loadSplashWindow(window: BrowserWindow): void {
  const entrypoints = resolveRendererEntrypoints(app.isPackaged, process.env.HERON_RENDERER_URL)
  void window.loadURL(entrypoints.splash)
}

export function secureWebPreferences(): WebPreferences {
  return {
    preload: join(import.meta.dirname, "../preload/index.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false
  }
}

export function createSplashWindow(): BrowserWindow {
  const window = new BrowserWindow({
    icon: applicationIconPath,
    show: false,
    width: 620,
    height: 360,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    frame: false,
    transparent: false,
    backgroundColor: "#0b0e13",
    webPreferences: secureWebPreferences()
  })
  splashWindow = window
  window.once("closed", () => {
    if (splashWindow === window) splashWindow = null
  })
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault()
  })
  loadSplashWindow(window)
  return window
}

export function createMainWindow(loadContent = true): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show()
    mainWindow.focus()
    return mainWindow
  }

  const window = new BrowserWindow({
    icon: applicationIconPath,
    show: loadContent,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0e13",
    ...mainWindowPlatformOptions(process.platform),
    webPreferences: secureWebPreferences()
  })
  mainWindow = window
  window.on("close", (event) => {
    deferProjectClose({
      command: "window.close",
      event,
      project: projectService?.current ?? null,
      window
    })
  })
  window.once("closed", () => {
    if (mainWindow === window) mainWindow = null
  })

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url)
    return { action: "deny" }
  })
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault()
  })
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("Heron renderer process exited", details)
  })
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("Heron renderer failed to load", { code, description })
  })

  if (loadContent) loadMainWindow(window)

  return window
}

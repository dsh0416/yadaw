import { BrowserWindow, shell } from "electron"
import { join } from "node:path"
import { deferProjectClose } from "./dirty-project-close"
import type { ProjectService } from "./project-service"
import { applicationIconPath, rendererDirectory } from "./runtime-paths"

let projectService: ProjectService | null = null

export function setWindowProjectService(service: ProjectService): void {
  projectService = service
}

export let mainWindow: BrowserWindow | null = null
export let splashWindow: BrowserWindow | null = null

export function openExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false
    void shell.openExternal(parsed.toString()).catch((error: unknown) => {
      console.error("YADAW could not open an external URL", error)
    })
    return true
  } catch {
    return false
  }
}

export function loadMainWindow(window: BrowserWindow): void {
  if (process.env.YADAW_RENDERER_URL) {
    void window.loadURL(process.env.YADAW_RENDERER_URL)
  } else {
    void window.loadFile(join(rendererDirectory, "index.html"))
  }
}

export function loadSplashWindow(window: BrowserWindow): void {
  if (process.env.YADAW_RENDERER_URL) {
    void window.loadURL(new URL("splash.html", process.env.YADAW_RENDERER_URL).toString())
  } else {
    void window.loadFile(join(rendererDirectory, "splash.html"))
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
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  splashWindow = window
  window.once("closed", () => {
    if (splashWindow === window) splashWindow = null
  })
  window.once("ready-to-show", () => {
    if (!window.isDestroyed()) window.show()
  })
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
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

  const isMacOS = process.platform === "darwin"
  const usesWindowControlsOverlay = process.platform === "linux"
  const window = new BrowserWindow({
    icon: applicationIconPath,
    show: loadContent,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0b0e13",
    titleBarStyle: isMacOS ? "hiddenInset" : "hidden",
    ...(isMacOS
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : usesWindowControlsOverlay
        ? {
            titleBarOverlay: {
              color: "#151515",
              symbolColor: "#e8e8e8",
              height: 38
            }
          }
        : {}),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
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
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== window.webContents.getURL()) {
      event.preventDefault()
    }
  })
  window.webContents.on("render-process-gone", (_event, details) => {
    console.error("YADAW renderer process exited", details)
  })
  window.webContents.on("did-fail-load", (_event, code, description) => {
    console.error("YADAW renderer failed to load", { code, description })
  })

  if (loadContent) loadMainWindow(window)

  return window
}

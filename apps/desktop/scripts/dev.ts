import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import { build, createServer } from "vite"
import type { ViteDevServer } from "vite"

const appDirectory = resolve(import.meta.dirname, "..")
const electronModule: unknown = createRequire(import.meta.url)("electron")
if (typeof electronModule !== "string") {
  throw new TypeError("electron did not resolve to its executable path")
}
const electronPath = electronModule
type BuildWatcher = Extract<Awaited<ReturnType<typeof build>>, { close(): Promise<void> }>

let electronProcess: ChildProcess | null = null
let rendererServer: ViteDevServer | null = null
let shuttingDown = false
let restartInProgress = false
let restartTimer: NodeJS.Timeout | null = null
let shutdownPromise: Promise<never> | null = null
const watchers: BuildWatcher[] = []

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolveExit) => {
    const timer = setTimeout(resolveExit, timeoutMs)
    timer.unref()
    child.once("exit", () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

async function terminateElectron(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = waitForExit(child)
  if (process.platform === "win32") {
    await new Promise((resolveKill) => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true
      })
      killer.once("error", resolveKill)
      killer.once("exit", resolveKill)
    })
  } else {
    child.kill("SIGTERM")
  }
  await exited
}

async function createBuildWatcher(configName: string, onRebuild: () => void): Promise<void> {
  const watcher = await build({
    configFile: resolve(appDirectory, configName),
    mode: "development",
    build: { watch: {} }
  })

  if (!("on" in watcher)) {
    throw new Error(`${configName} did not create a Vite build watcher`)
  }

  let firstBuild = true
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    watcher.on("event", (event) => {
      if (event.code === "ERROR") {
        if (firstBuild) rejectReady(event.error)
        return
      }
      if (event.code !== "END") return

      if (firstBuild) {
        firstBuild = false
        resolveReady()
      } else {
        onRebuild()
      }
    })
  })

  watchers.push(watcher)
  return ready
}

function launchElectron(): void {
  const rendererUrl = rendererServer?.resolvedUrls?.local[0]
  if (!rendererUrl) throw new Error("Vite renderer URL is unavailable")

  const launchedProcess = spawn(electronPath, [appDirectory], {
    env: { ...process.env, YADAW_RENDERER_URL: rendererUrl },
    stdio: "inherit"
  })
  electronProcess = launchedProcess

  launchedProcess.once("exit", () => {
    if (electronProcess === launchedProcess) electronProcess = null
    if (!shuttingDown && !restartInProgress && restartTimer === null) {
      void shutdown(0)
    }
  })
}

function scheduleElectronRestart(): void {
  if (restartTimer !== null) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => void restartElectron(), 120)
}

async function restartElectron(): Promise<void> {
  restartTimer = null
  if (!electronProcess) {
    launchElectron()
    return
  }

  restartInProgress = true
  const child = electronProcess
  await terminateElectron(child)
  if (!shuttingDown) launchElectron()
  restartInProgress = false
}

function shutdown(exitCode: number): Promise<never> {
  if (shutdownPromise) return shutdownPromise
  shuttingDown = true
  shutdownPromise = (async () => {
    if (restartTimer !== null) clearTimeout(restartTimer)
    const child = electronProcess
    await terminateElectron(child)
    await Promise.allSettled(watchers.map((watcher) => watcher.close()))
    await rendererServer?.close()
    process.exit(exitCode)
  })()
  return shutdownPromise
}

process.once("SIGINT", () => void shutdown(0))
process.once("SIGTERM", () => void shutdown(0))

try {
  const buildsReady = Promise.all([
    createBuildWatcher("vite.main.config.ts", scheduleElectronRestart),
    createBuildWatcher("vite.preload.config.ts", scheduleElectronRestart)
  ])

  rendererServer = await createServer({
    configFile: resolve(appDirectory, "vite.renderer.config.ts"),
    mode: "development"
  })
  await rendererServer.listen()
  rendererServer.printUrls()
  await buildsReady
  launchElectron()
} catch (error) {
  console.error(error)
  await shutdown(1)
}

import { spawn } from "node:child_process"
import { resolve } from "node:path"
import electronPath from "electron"
import { build, createServer } from "vite"

const appDirectory = resolve(import.meta.dirname, "..")
let electronProcess = null
let rendererServer = null
let shuttingDown = false
let restartInProgress = false
let restartTimer = null
let shutdownPromise = null
const watchers = []

function waitForExit(child, timeoutMs = 5_000) {
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

async function terminateElectron(child) {
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

async function createBuildWatcher(configName, onRebuild) {
  const watcher = await build({
    configFile: resolve(appDirectory, configName),
    mode: "development",
    build: { watch: {} }
  })

  if (!("on" in watcher)) {
    throw new Error(`${configName} did not create a Vite build watcher`)
  }

  let firstBuild = true
  const ready = new Promise((resolveReady, rejectReady) => {
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

function launchElectron() {
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

function scheduleElectronRestart() {
  if (restartTimer !== null) clearTimeout(restartTimer)
  restartTimer = setTimeout(async () => {
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
  }, 120)
}

function shutdown(exitCode) {
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

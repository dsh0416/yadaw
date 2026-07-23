import { spawn } from "node:child_process"
import { resolve } from "node:path"
import electronPath from "electron"
import { build, createServer } from "vite"

const appDirectory = resolve(import.meta.dirname, "..")
let electronProcess = null
let rendererServer = null
let shuttingDown = false
let restartTimer = null
const watchers = []

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

  electronProcess = spawn(electronPath, [appDirectory], {
    env: { ...process.env, YADAW_RENDERER_URL: rendererUrl },
    stdio: "inherit"
  })

  electronProcess.once("exit", () => {
    electronProcess = null
    if (!shuttingDown && restartTimer === null) {
      void shutdown(0)
    }
  })
}

function scheduleElectronRestart() {
  if (restartTimer !== null) clearTimeout(restartTimer)
  restartTimer = setTimeout(() => {
    restartTimer = null
    if (!electronProcess) {
      launchElectron()
      return
    }

    electronProcess.once("exit", launchElectron)
    electronProcess.kill()
  }, 120)
}

async function shutdown(exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  if (restartTimer !== null) clearTimeout(restartTimer)
  electronProcess?.kill()
  await Promise.allSettled(watchers.map((watcher) => watcher.close()))
  await rendererServer?.close()
  process.exit(exitCode)
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


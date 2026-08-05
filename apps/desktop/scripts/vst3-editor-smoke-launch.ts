import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const electronModule: unknown = createRequire(import.meta.url)("electron")
if (typeof electronModule !== "string") {
  throw new TypeError("electron did not resolve to its executable path")
}

const electronArguments = [
  ...(process.env.HERON_EDITOR_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
  resolve(import.meta.dirname, "vst3-editor-smoke-app"),
  ...process.argv.slice(2)
]

const child = spawn(electronModule, electronArguments, { stdio: "inherit" })

const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
  child.once("error", rejectExit)
  child.once("exit", (code, signal) => {
    if (signal) {
      rejectExit(new Error(`VST3 editor smoke exited with ${signal}`))
    } else {
      resolveExit(code ?? 1)
    }
  })
})

process.exitCode = exitCode

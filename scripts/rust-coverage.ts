#!/usr/bin/env node
/**
 * Collect Rust coverage from cargo tests and from JS VST3 smoke tests that
 * launch instrumented yadaw-audio-host / yadaw-vst3-probe binaries.
 *
 * Flow:
 * 1. `cargo llvm-cov --no-report` runs the workspace tests (sccache-friendly)
 * 2. `show-env` exports LLVM_PROFILE_FILE for external binary launches
 * 3. Build instrumented host + probe into target-coverage/
 * 4. Run JS smokes against those binaries so they write .profraw
 * 5. `cargo llvm-cov report` merges profiles into coverage/rust/lcov.info
 *
 * Set YADAW_COVERAGE_SKIP_VST3_SMOKE=1 to skip plugin builds and smokes.
 */
import { mkdirSync } from "node:fs"
import { spawn } from "node:child_process"
import { resolve } from "node:path"

const repositoryRoot = resolve(import.meta.dirname, "..")
const targetDir = resolve(repositoryRoot, "target-coverage")
const lcovPath = resolve(repositoryRoot, "coverage/rust/lcov.info")
const ignoreFilenameRegex = "(/|^)third_party/"
const rustFeatures = "yadaw-dsp-node/bench-internals"
const skipVst3Smoke = process.env.YADAW_COVERAGE_SKIP_VST3_SMOKE === "1"
const executableSuffix = process.platform === "win32" ? ".exe" : ""
/** Soft ceiling for each JS smoke so a stuck editor/host cannot exhaust CI. */
const smokeTimeoutMs = Number.parseInt(process.env.YADAW_COVERAGE_SMOKE_TIMEOUT_MS ?? "180000", 10)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function parseShowEnv(stdout: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("export ")) continue
    const eq = line.indexOf("=")
    if (eq < 0) continue
    const key = line.slice("export ".length, eq)
    let value = line.slice(eq + 1)
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    env[key] = value
  }
  if (!env.LLVM_PROFILE_FILE) {
    fail("cargo llvm-cov show-env did not export LLVM_PROFILE_FILE")
  }
  return env
}

function run(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  options: { cwd?: string; timeoutMs?: number } = {}
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env,
      stdio: "inherit"
    })
    let timedOut = false
    const timer =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            child.kill("SIGKILL")
          }, options.timeoutMs)
        : undefined
    child.once("error", (error) => {
      if (timer) clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code, signal) => {
      if (timer) clearTimeout(timer)
      if (timedOut) {
        reject(new Error(`${command} ${args.join(" ")} timed out after ${options.timeoutMs}ms`))
        return
      }
      if (signal) {
        reject(new Error(`${command} exited from signal ${signal}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "unknown"})`))
        return
      }
      resolvePromise()
    })
  })
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      stdio: ["ignore", "pipe", "inherit"]
    })
    let stdout = ""
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited from signal ${signal}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code ?? "unknown"})`))
        return
      }
      resolvePromise(stdout)
    })
  })
}

function withDisplay(command: string, args: string[]): { command: string; args: string[] } {
  if (process.env.DISPLAY || process.platform !== "linux") {
    return { command, args }
  }
  return {
    command: "xvfb-run",
    args: ["-a", "-s", "-screen 0 1280x720x24", "--", command, ...args]
  }
}

function debugBinary(name: string): string {
  return resolve(targetDir, "debug", `${name}${executableSuffix}`)
}

async function runVst3Smokes(smokeEnv: NodeJS.ProcessEnv): Promise<void> {
  // Built-in plugs are not coverage-instrumented; only the host/probe are.
  console.log("Building built-in VST3 plugs for coverage smokes...")
  await run("cargo", ["truce", "build", "--vst3", "--debug"], process.env)
  await run("pnpm", ["--filter", "@yadaw/audio-host-client", "build:debug"], process.env)

  const hostPath = debugBinary("yadaw-audio-host")
  const gainPath = resolve(repositoryRoot, "target", "bundles", "YADAW Gain.vst3")
  const sinePath = resolve(repositoryRoot, "target", "bundles", "YADAW Sine.vst3")

  console.log("Running builtin VST3 probe smoke...")
  await run("node", ["apps/desktop/scripts/builtin-vst3-smoke.ts"], smokeEnv, {
    timeoutMs: smokeTimeoutMs
  })

  console.log("Running audio-benchmark smoke...")
  await run("node", ["apps/desktop/scripts/audio-benchmark-smoke.ts"], smokeEnv, {
    timeoutMs: smokeTimeoutMs
  })

  console.log("Running VST3 editor smoke...")
  const editorSmoke = withDisplay("node", [
    "apps/desktop/scripts/vst3-editor-smoke.ts",
    hostPath,
    gainPath,
    "59CABE21E605B9C9EE928D6C3B236BBF",
    "effect"
  ])
  await run(editorSmoke.command, editorSmoke.args, smokeEnv, { timeoutMs: smokeTimeoutMs })

  console.log("Running VST3 helper live-graph smoke...")
  const helperSmoke = withDisplay("node", [
    "apps/desktop/scripts/vst3-helper-smoke.ts",
    hostPath,
    gainPath,
    sinePath,
    "59CABE21E605B9C9EE928D6C3B236BBF",
    "F7BC8CA3E5E8B9C9EE928D7114950FBF"
  ])
  await run(helperSmoke.command, helperSmoke.args, smokeEnv, { timeoutMs: smokeTimeoutMs })
}

async function main(): Promise<void> {
  mkdirSync(resolve(repositoryRoot, "coverage/rust"), { recursive: true })

  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_TARGET_DIR: targetDir
  }

  // Keep the original llvm-cov test path: it chains sccache and avoids a
  // workspace clean that would force a cold instrumented rebuild every CI run.
  console.log("Running instrumented cargo tests (no report yet)...")
  await run(
    "cargo",
    ["llvm-cov", "--no-report", "--workspace", "--features", rustFeatures],
    baseEnv
  )

  const showEnv = parseShowEnv(await capture("cargo", ["llvm-cov", "show-env", "--sh"], baseEnv))
  const covEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...showEnv,
    CARGO_TARGET_DIR: targetDir
  }

  console.log("Building instrumented audio-host and vst3-probe...")
  // Build packages separately: `--bin yadaw-vst3-probe` would otherwise skip
  // yadaw-audio-host, which has a different binary name.
  await run("cargo", ["build", "-p", "yadaw-audio-host"], covEnv)
  await run("cargo", ["build", "-p", "yadaw-vst3-host", "--bin", "yadaw-vst3-probe"], covEnv)

  if (skipVst3Smoke) {
    console.log("Skipping VST3 JS smoke coverage (YADAW_COVERAGE_SKIP_VST3_SMOKE=1)")
  } else {
    const smokeEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LLVM_PROFILE_FILE: showEnv.LLVM_PROFILE_FILE,
      CARGO_TARGET_DIR: targetDir,
      CARGO_LLVM_COV_TARGET_DIR: showEnv.CARGO_LLVM_COV_TARGET_DIR ?? targetDir,
      // Keep editor observation short in CI/coverage runs.
      YADAW_EDITOR_SMOKE_DELAY_MS: process.env.YADAW_EDITOR_SMOKE_DELAY_MS ?? "50"
    }
    await runVst3Smokes(smokeEnv)
  }

  console.log("Merging Rust coverage report...")
  await run(
    "cargo",
    [
      "llvm-cov",
      "report",
      "--ignore-filename-regex",
      ignoreFilenameRegex,
      "--lcov",
      "--output-path",
      lcovPath
    ],
    {
      ...process.env,
      CARGO_TARGET_DIR: targetDir,
      CARGO_LLVM_COV_TARGET_DIR: showEnv.CARGO_LLVM_COV_TARGET_DIR ?? targetDir
    }
  )
  console.log(`Rust coverage written to ${lcovPath}`)
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})

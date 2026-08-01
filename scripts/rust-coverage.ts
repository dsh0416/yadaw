#!/usr/bin/env node
/**
 * Collect Rust coverage from cargo tests and from JS VST3 smoke tests that
 * launch instrumented yadaw-audio-host / yadaw-vst3-probe binaries.
 *
 * Flow (cargo-llvm-cov "external tests" pattern):
 * 1. show-env → RUSTFLAGS / LLVM_PROFILE_FILE / target dir
 * 2. cargo test (instrumented)
 * 3. cargo build instrumented host + probe
 * 4. build built-in VST3 plugs and run JS smokes against those bins
 * 5. cargo llvm-cov report merges .profraw into coverage/rust/lcov.info
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
  options: { cwd?: string } = {}
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env,
      stdio: "inherit"
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
  return { command: "xvfb-run", args: ["-a", "--", command, ...args] }
}

function debugBinary(name: string): string {
  return resolve(targetDir, "debug", `${name}${executableSuffix}`)
}

async function runVst3Smokes(smokeEnv: NodeJS.ProcessEnv): Promise<void> {
  // Built-in plugs are not coverage-instrumented; only the host/probe are.
  await run("cargo", ["truce", "build", "--vst3", "--debug"], process.env)
  await run("pnpm", ["--filter", "@yadaw/audio-host-client", "build:debug"], process.env)

  const hostPath = debugBinary("yadaw-audio-host")
  const gainPath = resolve(repositoryRoot, "target", "bundles", "YADAW Gain.vst3")
  const sinePath = resolve(repositoryRoot, "target", "bundles", "YADAW Sine.vst3")

  // Probe exercises module open / class init / processor setup / teardown.
  await run("node", ["apps/desktop/scripts/builtin-vst3-smoke.ts"], smokeEnv)

  // Host live-graph + processing coverage via the audio benchmark smoke.
  await run("node", ["apps/desktop/scripts/audio-benchmark-smoke.ts"], smokeEnv)

  // Editor open/focus/close against a built-in plug (Steinberg SDK fixtures are
  // still covered by `pnpm test:vst3-fixtures` outside the coverage path).
  const editorSmoke = withDisplay("node", [
    "apps/desktop/scripts/vst3-editor-smoke.ts",
    hostPath,
    gainPath,
    "59CABE21E605B9C9EE928D6C3B236BBF",
    "effect"
  ])
  await run(editorSmoke.command, editorSmoke.args, smokeEnv)

  // Helper smoke against built-in instrument + effect, so load/parameter/editor/
  // graph/transport paths write .profraw from the instrumented host.
  const helperSmoke = withDisplay("node", [
    "apps/desktop/scripts/vst3-helper-smoke.ts",
    hostPath,
    gainPath,
    sinePath,
    "59CABE21E605B9C9EE928D6C3B236BBF",
    "F7BC8CA3E5E8B9C9EE928D7114950FBF"
  ])
  await run(helperSmoke.command, helperSmoke.args, smokeEnv)
}

async function main(): Promise<void> {
  mkdirSync(resolve(repositoryRoot, "coverage/rust"), { recursive: true })

  const showEnv = parseShowEnv(
    await capture("cargo", ["llvm-cov", "show-env", "--sh"], {
      ...process.env,
      CARGO_TARGET_DIR: targetDir
    })
  )

  const covEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...showEnv,
    CARGO_TARGET_DIR: targetDir
  }

  // show-env must precede clean; both must precede instrumented builds.
  await run("cargo", ["llvm-cov", "clean", "--workspace"], covEnv)
  await run("cargo", ["test", "--workspace", "--features", rustFeatures], covEnv)
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
      CARGO_LLVM_COV_TARGET_DIR: showEnv.CARGO_LLVM_COV_TARGET_DIR ?? targetDir
    }
    await runVst3Smokes(smokeEnv)
  }

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
    covEnv
  )
  console.log(`Rust coverage written to ${lcovPath}`)
}

main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})

#!/usr/bin/env node
/**
 * Collect JavaScript and Rust coverage in one pass.
 *
 * cargo-llvm-cov's external-test environment instruments the napi-rs addons,
 * lets Vitest exercise them, and merges those profiles with the profiles from
 * the single Cargo test run before exporting LCOV.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { resolve } from "node:path"

const workspaceRoot = resolve(import.meta.dirname, "..")
const coverageTarget = resolve(workspaceRoot, "target-coverage")
const rustCoveragePath = resolve(workspaceRoot, "coverage/rust/lcov.info")
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo"
const rustCoverageFeatures = "yadaw-dsp-node/bench-internals"

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  console.log(`\n> ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env,
    stdio: "inherit"
  })

  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

function capture(command: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "inherit"]
  })

  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

function runPnpm(args: string[], env: NodeJS.ProcessEnv): void {
  if (process.platform === "win32") {
    run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm", ...args], env)
    return
  }
  run("pnpm", args, env)
}

function hostTarget(env: NodeJS.ProcessEnv): string {
  const verboseVersion = capture("rustc", ["-vV"], env)
  const target = verboseVersion.match(/^host:\s*(\S+)$/m)?.[1]
  if (!target) fail("Could not determine the Rust host target from `rustc -vV`.")
  return target
}

function cargoCoverageEnvironment(target: string): NodeJS.ProcessEnv {
  const baseEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    CARGO_TARGET_DIR: coverageTarget
  }
  const output = capture(cargo, ["llvm-cov", "show-env", "--target", target], baseEnvironment)
  const environment: NodeJS.ProcessEnv = { ...baseEnvironment }

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    const assignment = line.replace(/^(?:export\s+|set\s+)/u, "")
    const separator = assignment.indexOf("=")
    if (separator <= 0) fail(`Unexpected cargo llvm-cov environment line: ${rawLine}`)

    const key = assignment.slice(0, separator).trim()
    let value = assignment.slice(separator + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\")
    }

    environment[key] = value
  }

  return environment
}

const target = hostTarget(process.env)
const coverageEnvironment = cargoCoverageEnvironment(target)

// cargo-llvm-cov recommends cleaning after show-env and before instrumented builds.
run(cargo, ["llvm-cov", "clean", "--workspace"], coverageEnvironment)

run(
  cargo,
  ["test", "--workspace", "--features", rustCoverageFeatures, "--target", target],
  coverageEnvironment
)

// Build the cdylibs after Cargo tests so the final objects discovered by the
// report match the binaries copied into the JS packages and loaded by Node.
runPnpm(["--filter", "@yadaw/dsp-node", "build:debug"], coverageEnvironment)
runPnpm(["--filter", "@yadaw/audio-host-client", "build:debug"], coverageEnvironment)
runPnpm(["test:coverage:js"], coverageEnvironment)
runPnpm(["test:native-bindings"], coverageEnvironment)

mkdirSync(resolve(workspaceRoot, "coverage/rust"), { recursive: true })
run(
  cargo,
  [
    "llvm-cov",
    "report",
    "--target",
    target,
    "--ignore-filename-regex",
    "(/|^)third_party/",
    "--lcov",
    "--output-path",
    rustCoveragePath
  ],
  coverageEnvironment
)

console.log(`\nCombined Rust coverage written to ${rustCoveragePath}`)

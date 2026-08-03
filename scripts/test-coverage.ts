#!/usr/bin/env node
/**
 * Collect JavaScript and Rust coverage in one pass.
 *
 * cargo-llvm-cov's external-test environment instruments the napi-rs addons,
 * lets Vitest exercise them, and merges those profiles with the profiles from
 * the single Cargo test run before exporting LCOV.
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const workspaceRoot = resolve(import.meta.dirname, "..")
const coverageTarget = resolve(workspaceRoot, "target-coverage")
const rustCoveragePath = resolve(workspaceRoot, "coverage/rust/lcov.info")
const cargo = process.platform === "win32" ? "cargo.exe" : "cargo"
const rustCoverageFeatures = "heron-dsp-node/bench-internals"
const coveragePhases = ["all", "prepare", "finish"] as const
type CoveragePhase = (typeof coveragePhases)[number]

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
  // Request cmd syntax on every host because it is a simple `set KEY=VALUE`
  // grammar. The default POSIX output shell-quotes values, which must not be
  // copied literally into spawn's environment.
  const output = capture(
    cargo,
    ["llvm-cov", "show-env", "--cmd", "--target", target],
    baseEnvironment
  )
  const environment: NodeJS.ProcessEnv = { ...baseEnvironment }

  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue

    if (!line.startsWith("set ")) {
      fail(`Unexpected cargo llvm-cov environment line: ${rawLine}`)
    }
    const assignment = line.slice("set ".length)
    const separator = assignment.indexOf("=")
    if (separator <= 0) fail(`Unexpected cargo llvm-cov environment line: ${rawLine}`)

    const key = assignment.slice(0, separator).trim()
    const value = assignment.slice(separator + 1)
    environment[key] = value
  }

  return environment
}

function requestedCoveragePhase(): CoveragePhase {
  const requested = process.argv[2] ?? "all"
  if (!coveragePhases.includes(requested as CoveragePhase)) {
    fail(`Unknown coverage phase '${requested}'. Expected: ${coveragePhases.join(", ")}.`)
  }
  return requested as CoveragePhase
}

function prepareCoverage(target: string, environment: NodeJS.ProcessEnv): void {
  // cargo-llvm-cov recommends cleaning after show-env and before instrumented builds.
  run(cargo, ["llvm-cov", "clean", "--workspace"], environment)

  run(
    cargo,
    ["test", "--workspace", "--features", rustCoverageFeatures, "--target", target],
    environment
  )

  // Build the cdylibs after Cargo tests so the final objects discovered by the
  // report match the binaries copied into the JS packages and loaded by Node.
  // This also generates the gitignored loaders and typings required by typed lint.
  runPnpm(["--filter", "@heron/dsp-node", "build:debug"], environment)
  runPnpm(["--filter", "@heron/audio-host-client", "build:debug"], environment)
}

function requirePreparedBindings(): void {
  const requiredFiles = [
    "crates/dsp-node/index.js",
    "crates/dsp-node/index.d.ts",
    "crates/audio-host-client/index.js",
    "crates/audio-host-client/index.d.ts"
  ]
  const missingFiles = requiredFiles.filter((path) => !existsSync(resolve(workspaceRoot, path)))
  if (missingFiles.length > 0) {
    fail(
      `Coverage preparation is incomplete; missing ${missingFiles.join(", ")}. Run pnpm test:coverage:prepare first.`
    )
  }
}

function finishCoverage(target: string, environment: NodeJS.ProcessEnv): void {
  requirePreparedBindings()
  runPnpm(["test:coverage:js"], environment)
  runPnpm(["test:native-bindings"], environment)

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
    environment
  )

  console.log(`\nCombined Rust coverage written to ${rustCoveragePath}`)
}

const phase = requestedCoveragePhase()
const target = hostTarget(process.env)
const coverageEnvironment = cargoCoverageEnvironment(target)

if (phase !== "finish") prepareCoverage(target, coverageEnvironment)
if (phase !== "prepare") finishCoverage(target, coverageEnvironment)

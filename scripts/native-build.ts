#!/usr/bin/env node
import { copyFileSync, cpSync, mkdirSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { cargoExecutable, fail, hostTarget, run, runPnpm, workspaceRoot } from "./rust-target.ts"

const modes = ["debug", "release"] as const
const scopes = ["all", "addons", "binaries"] as const
type BuildMode = (typeof modes)[number]
type BuildScope = (typeof scopes)[number]

const mode = (process.argv[2] ?? "debug") as BuildMode
const scope = (process.argv[3] ?? "all") as BuildScope
if (!modes.includes(mode)) fail(`Unknown build mode '${mode}'. Expected: ${modes.join(", ")}.`)
if (!scopes.includes(scope)) fail(`Unknown build scope '${scope}'. Expected: ${scopes.join(", ")}.`)

const target = hostTarget()
const release = mode === "release"

if (scope !== "binaries") {
  for (const packageName of ["@heron/dsp-node"]) {
    runPnpm([
      "--filter",
      packageName,
      "exec",
      "napi",
      "build",
      "--platform",
      "--target",
      target,
      ...(release ? ["--release"] : [])
    ])
  }
}

if (scope !== "addons") {
  run(cargoExecutable, [
    "build",
    "--target",
    target,
    ...(release ? ["--release"] : []),
    "-p",
    "heron-vst3-host",
    "--bin",
    "heron-vst3-probe"
  ])
  run(cargoExecutable, [
    "truce",
    "build",
    "--vst3",
    "--target",
    target,
    ...(!release ? ["--debug"] : [])
  ])

  const targetBundleDirectory = resolve(workspaceRoot, "target", "bundles", target)
  const stableBundleDirectory = resolve(workspaceRoot, "target", "bundles")
  for (const entry of readdirSync(targetBundleDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".vst3")) continue
    cpSync(resolve(targetBundleDirectory, entry.name), resolve(stableBundleDirectory, entry.name), {
      recursive: true,
      force: true
    })
  }

  const profile = release ? "release" : "debug"
  const executableSuffix = process.platform === "win32" ? ".exe" : ""
  const sourceDirectory = resolve(workspaceRoot, "target", target, profile)
  const stableDirectory = resolve(workspaceRoot, "target", profile)
  mkdirSync(stableDirectory, { recursive: true })
  for (const binary of ["heron-vst3-probe"]) {
    copyFileSync(
      resolve(sourceDirectory, `${binary}${executableSuffix}`),
      resolve(stableDirectory, `${binary}${executableSuffix}`)
    )
  }
}

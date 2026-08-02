import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

export const workspaceRoot = resolve(import.meta.dirname, "..")
export const cargoExecutable = process.platform === "win32" ? "cargo.exe" : "cargo"

export function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export function run(command: string, args: readonly string[]): void {
  console.log(`\n> ${command} ${args.join(" ")}`)
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    env: process.env,
    stdio: "inherit"
  })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
}

export function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"]
  })
  if (result.error) fail(`${command} failed to start: ${result.error.message}`)
  if (result.status !== 0) process.exit(result.status ?? 1)
  return result.stdout
}

export function hostTarget(): string {
  const target = capture("rustc", ["-vV"]).match(/^host:\s*(\S+)$/mu)?.[1]
  if (!target) fail("Could not determine the Rust host target from `rustc -vV`.")
  return target
}

/** Cargo args before `--` (binary args). Mutates `cargoArgs` when injecting. */
export function ensureHostCargoTarget(cargoArgs: string[], target = hostTarget()): string[] {
  const separator = cargoArgs.indexOf("--")
  const cargoOwned = separator === -1 ? cargoArgs : cargoArgs.slice(0, separator)
  if (cargoOwned.includes("--target")) return cargoArgs
  const insertion = separator === -1 ? cargoArgs.length : separator
  cargoArgs.splice(insertion, 0, "--target", target)
  return cargoArgs
}

export function runPnpm(args: readonly string[]): void {
  if (process.platform === "win32") {
    run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "pnpm", ...args])
    return
  }
  run("pnpm", args)
}

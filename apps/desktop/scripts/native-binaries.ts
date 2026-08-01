import { resolve } from "node:path"

const executableSuffix = process.platform === "win32" ? ".exe" : ""

/** Resolve the Cargo target directory used for debug host/probe binaries. */
export function cargoTargetDir(repositoryRoot: string): string {
  const fromEnv = process.env.CARGO_TARGET_DIR ?? process.env.CARGO_LLVM_COV_TARGET_DIR
  if (fromEnv) {
    return resolve(fromEnv)
  }
  return resolve(repositoryRoot, "target")
}

/** Path to a debug Cargo binary, honoring coverage/instrumented target dirs. */
export function debugBinary(repositoryRoot: string, name: string): string {
  return resolve(cargoTargetDir(repositoryRoot), "debug", `${name}${executableSuffix}`)
}

export function audioHostBinary(repositoryRoot: string): string {
  return process.env.YADAW_AUDIO_HOST ?? debugBinary(repositoryRoot, "yadaw-audio-host")
}

export function vst3ProbeBinary(repositoryRoot: string): string {
  return process.env.YADAW_VST3_PROBE ?? debugBinary(repositoryRoot, "yadaw-vst3-probe")
}

import { access, readdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { FuseState, FuseV1Options, getCurrentFuseWire, type FuseConfig } from "@electron/fuses"

const releaseDirectory = resolve(import.meta.dirname, "../../../release")

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findPackagedExecutable(): Promise<string> {
  const directories = (await readdir(releaseDirectory, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory()
  )
  const candidates: string[] = []

  for (const directory of directories) {
    const root = join(releaseDirectory, directory.name)
    const candidate =
      process.platform === "win32"
        ? join(root, "heron.exe")
        : process.platform === "darwin"
          ? join(root, "Heron.app", "Contents", "MacOS", "heron")
          : join(root, "heron")
    if (await exists(candidate)) candidates.push(candidate)
  }

  const [candidate] = candidates
  if (!candidate || candidates.length !== 1) {
    throw new Error(
      `Expected exactly one unpacked Heron executable in ${releaseDirectory}, found ${candidates.length}`
    )
  }
  return candidate
}

function stateName(state: FuseState | undefined): string {
  return state === undefined ? "missing" : (FuseState[state] ?? String(state))
}

function assertFuse(
  fuses: FuseConfig<FuseState>,
  option: FuseV1Options,
  expected: FuseState
): void {
  const actual = fuses[option]
  if (actual !== expected) {
    throw new Error(
      `${FuseV1Options[option]} must be ${stateName(expected)}, received ${stateName(actual)}`
    )
  }
}

const executable = await findPackagedExecutable()
const resourcesDirectory =
  process.platform === "darwin"
    ? resolve(dirname(executable), "../Resources")
    : join(dirname(executable), "resources")
const asarPath = join(resourcesDirectory, "app.asar")
if (!(await exists(asarPath))) {
  throw new Error(`Packaged application archive is missing: ${asarPath}`)
}

const fuses = await getCurrentFuseWire(executable)
assertFuse(fuses, FuseV1Options.RunAsNode, FuseState.DISABLE)
assertFuse(fuses, FuseV1Options.EnableCookieEncryption, FuseState.ENABLE)
assertFuse(fuses, FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE)
assertFuse(fuses, FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE)
assertFuse(fuses, FuseV1Options.EnableEmbeddedAsarIntegrityValidation, FuseState.ENABLE)
assertFuse(fuses, FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE)
assertFuse(fuses, FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE)

console.log(`Verified Electron fuses and app.asar for ${executable}`)

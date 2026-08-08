import { spawnSync } from "node:child_process"
import { access, readFile, readdir } from "node:fs/promises"
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

function runInspection(command: string, args: string[], input?: string): string {
  const inspection = spawnSync(command, args, { encoding: "utf8", input })
  if (inspection.status !== 0) {
    const details = inspection.stderr.trim() || inspection.stdout.trim() || "unknown error"
    throw new Error(`${command} ${args.join(" ")} failed: ${details}`)
  }
  return inspection.stdout.trim()
}

function parsePlist(input: string): Record<string, unknown> {
  return JSON.parse(runInspection("plutil", ["-convert", "json", "-o", "-", "-"], input)) as Record<
    string,
    unknown
  >
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

if (process.platform === "darwin") {
  const appBundle = resolve(dirname(executable), "../..")
  const infoPlist = join(appBundle, "Contents", "Info.plist")
  const verification = spawnSync(
    "codesign",
    ["--verify", "--deep", "--strict", "--all-architectures", "--verbose=2", appBundle],
    { encoding: "utf8" }
  )
  if (verification.status !== 0) {
    const details = verification.stderr.trim() || verification.stdout.trim() || "unknown error"
    throw new Error(`Packaged macOS application has an invalid code signature: ${details}`)
  }

  const info = parsePlist(await readFile(infoPlist, "utf8"))
  const microphoneUsageDescription = info.NSMicrophoneUsageDescription
  if (typeof microphoneUsageDescription !== "string" || !microphoneUsageDescription.trim()) {
    throw new Error("Packaged macOS application has an empty microphone usage description")
  }

  const entitlementInspection = spawnSync(
    "codesign",
    ["--display", "--entitlements", ":-", appBundle],
    { encoding: "utf8" }
  )
  if (entitlementInspection.status !== 0) {
    const details =
      entitlementInspection.stderr.trim() || entitlementInspection.stdout.trim() || "unknown error"
    throw new Error(`Unable to inspect packaged macOS entitlements: ${details}`)
  }
  const entitlementOutput = `${entitlementInspection.stdout}\n${entitlementInspection.stderr}`
  const plistStart = entitlementOutput.indexOf("<?xml")
  const plistEnd = entitlementOutput.lastIndexOf("</plist>")
  if (plistStart < 0 || plistEnd < plistStart) {
    throw new Error("codesign did not return a readable entitlement property list")
  }
  const entitlements = entitlementOutput.slice(plistStart, plistEnd + "</plist>".length)
  if (parsePlist(entitlements)["com.apple.security.device.audio-input"] !== true) {
    throw new Error("Packaged macOS application is missing the audio-input entitlement")
  }

  if (process.env.HERON_REQUIRE_DEVELOPER_ID_SIGNATURE === "true") {
    const inspection = spawnSync("codesign", ["--display", "--verbose=4", appBundle], {
      encoding: "utf8"
    })
    const details = `${inspection.stdout}\n${inspection.stderr}`
    if (
      inspection.status !== 0 ||
      !/^Authority=Developer ID Application:/m.test(details) ||
      !/^TeamIdentifier=(?!not set$).+/m.test(details)
    ) {
      throw new Error(
        `Packaged macOS application is not signed with Developer ID: ${details.trim()}`
      )
    }
  }

  if (process.env.HERON_REQUIRE_NOTARIZATION === "true") {
    const assessment = spawnSync(
      "spctl",
      ["--assess", "--type", "execute", "--verbose=2", appBundle],
      { encoding: "utf8" }
    )
    if (assessment.status !== 0) {
      const details = assessment.stderr.trim() || assessment.stdout.trim() || "unknown error"
      throw new Error(`Gatekeeper rejected the packaged macOS application: ${details}`)
    }

    const stapling = spawnSync("xcrun", ["stapler", "validate", appBundle], {
      encoding: "utf8"
    })
    if (stapling.status !== 0) {
      const details = stapling.stderr.trim() || stapling.stdout.trim() || "unknown error"
      throw new Error(`Packaged macOS application has no valid stapled ticket: ${details}`)
    }
  }
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

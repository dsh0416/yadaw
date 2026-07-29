import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const workspaceRoot = process.cwd()
const versionFilePath = join(workspaceRoot, "VERSION")
const cargoTomlPath = join(workspaceRoot, "Cargo.toml")
const packageGlobs = ["apps", "packages", "crates"] as const
const napiLoaderPaths = [
  join(workspaceRoot, "crates", "audio-host-client", "index.js"),
  join(workspaceRoot, "crates", "dsp-node", "index.js")
] as const
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const workspacePackageSection = /\[workspace\.package\][^\n]*\n([\s\S]*?)(?=\n\[|\s*$)/
const workspacePackageVersion = /^\s*version\s*=\s*"([^"]+)"/m
const packageJsonVersion = /^(\s*"version"\s*:\s*")([^"]+)(")/m
const napiLoaderVersion = /bindingPackageVersion !== '([^']+)'/g

type Target = {
  label: string
  path: string
  read: () => string
  write: (version: string) => void
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

function readCanonicalVersion(): string {
  let raw: string
  try {
    raw = readFileSync(versionFilePath, "utf8").trim()
  } catch {
    return fail(`Missing VERSION file at ${relative(workspaceRoot, versionFilePath)}`)
  }

  if (!semverPattern.test(raw)) {
    return fail(`VERSION must be a semver string, got ${JSON.stringify(raw)}`)
  }

  return raw
}

function collectPackageManifests(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (!statSync(path).isDirectory()) return []
    const manifest = join(path, "package.json")
    try {
      return statSync(manifest).isFile() ? [manifest] : []
    } catch {
      return []
    }
  })
}

function readPackageJsonVersion(path: string): string {
  const source = readFileSync(path, "utf8")
  const match = source.match(packageJsonVersion)
  if (!match?.[2]) {
    fail(`Missing top-level "version" in ${relative(workspaceRoot, path)}`)
  }
  return match[2]
}

function writePackageJsonVersion(path: string, version: string): void {
  const source = readFileSync(path, "utf8")
  if (!packageJsonVersion.test(source)) {
    fail(`Missing top-level "version" in ${relative(workspaceRoot, path)}`)
  }
  writeFileSync(path, source.replace(packageJsonVersion, `$1${version}$3`))
}

function readNapiLoaderVersion(path: string): string {
  const source = readFileSync(path, "utf8")
  const versions = new Set([...source.matchAll(napiLoaderVersion)].map((match) => match[1]))

  if (versions.size === 0) {
    fail(`Missing binding package version checks in ${relative(workspaceRoot, path)}`)
  }
  if (versions.size > 1) {
    fail(
      `Inconsistent binding package versions in ${relative(workspaceRoot, path)}: ${[...versions].join(", ")}`
    )
  }

  return [...versions][0]!
}

function readCargoWorkspaceVersion(): string {
  const source = readFileSync(cargoTomlPath, "utf8")
  const section = source.match(workspacePackageSection)?.[1]
  const version = section?.match(workspacePackageVersion)?.[1]
  if (!version) {
    fail(`Missing [workspace.package].version in Cargo.toml`)
  }
  return version
}

function writeCargoWorkspaceVersion(version: string): void {
  const source = readFileSync(cargoTomlPath, "utf8")
  const sectionMatch = source.match(workspacePackageSection)
  if (!sectionMatch?.[0] || sectionMatch.index === undefined) {
    fail(`Missing [workspace.package] section in Cargo.toml`)
  }

  if (!sectionMatch[1]?.match(workspacePackageVersion)) {
    fail(`Missing [workspace.package].version in Cargo.toml`)
  }

  const updatedSection = sectionMatch[0].replace(workspacePackageVersion, (line, current: string) =>
    line.replace(`"${current}"`, `"${version}"`)
  )
  const updated =
    source.slice(0, sectionMatch.index) +
    updatedSection +
    source.slice(sectionMatch.index + sectionMatch[0].length)

  writeFileSync(cargoTomlPath, updated)
}

function collectTargets(): Target[] {
  const packagePaths = [
    join(workspaceRoot, "package.json"),
    ...packageGlobs.flatMap((directory) => collectPackageManifests(join(workspaceRoot, directory)))
  ]

  return [
    {
      label: "Cargo.toml [workspace.package].version",
      path: cargoTomlPath,
      read: readCargoWorkspaceVersion,
      write: writeCargoWorkspaceVersion
    },
    ...packagePaths.map((path) => ({
      label: relative(workspaceRoot, path).replaceAll("\\", "/"),
      path,
      read: () => readPackageJsonVersion(path),
      write: (version: string) => writePackageJsonVersion(path, version)
    }))
  ]
}

function checkVersions(expected: string): void {
  const mismatches: string[] = []

  for (const target of collectTargets()) {
    const actual = target.read()
    if (actual !== expected) {
      mismatches.push(`  ${target.label}: ${actual} (expected ${expected})`)
    }
  }

  for (const path of napiLoaderPaths) {
    const actual = readNapiLoaderVersion(path)
    if (actual !== expected) {
      mismatches.push(
        `  ${relative(workspaceRoot, path).replaceAll("\\", "/")}: ${actual} (expected ${expected})`
      )
    }
  }

  if (mismatches.length > 0) {
    fail(
      [
        `Version mismatch against VERSION (${expected}):`,
        ...mismatches,
        "",
        "Run `pnpm sync:version` to synchronize manifests and generated loaders."
      ].join("\n")
    )
  }

  console.log(`All package and generated loader versions match VERSION (${expected}).`)
}

function syncVersions(expected: string): void {
  let updated = 0

  for (const target of collectTargets()) {
    const actual = target.read()
    if (actual === expected) continue
    target.write(expected)
    console.log(`Updated ${target.label}: ${actual} -> ${expected}`)
    updated += 1
  }

  if (updated === 0) {
    console.log(`All package versions already match VERSION (${expected}).`)
    return
  }

  console.log(`Synced ${updated} target(s) to ${expected}.`)
}

const command = process.argv[2]
const expected = readCanonicalVersion()

if (command === "check") {
  checkVersions(expected)
} else if (command === "sync") {
  syncVersions(expected)
} else {
  fail("Usage: node scripts/version.ts <check|sync>")
}

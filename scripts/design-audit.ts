import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"

const workspaceRoot = process.cwd()
const rendererRoot = join(workspaceRoot, "apps/desktop/src/renderer/src")
const uiRoot = join(workspaceRoot, "packages/ui/src")
const sourceExtensions = new Set([".css", ".ts", ".vue"])
const failures: string[] = []

function collectFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) return collectFiles(path)
    return sourceExtensions.has(extname(path)) ? [path] : []
  })
}

function report(file: string, rule: string, detail: string): void {
  failures.push(`${relative(workspaceRoot, file)}: ${rule}: ${detail}`)
}

const rendererFiles = collectFiles(rendererRoot)
const uiFiles = collectFiles(uiRoot)
const rawColor = /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi
const numericZIndex = /z-index\s*:\s*-?\d+/gi

for (const file of rendererFiles) {
  const source = readFileSync(file, "utf8")
  const isTest = /\.test\.ts$/.test(file)

  if (/from\s+["']reka-ui["']/.test(source)) {
    report(file, "renderer-boundary", "import @yadaw/ui instead of reka-ui")
  }
  if (/<Teleport\b/.test(source)) {
    report(file, "overlay-boundary", "manual Teleport overlays are not allowed")
  }
  if (!isTest) {
    for (const match of source.matchAll(rawColor)) {
      report(file, "raw-color", match[0])
    }
  }
  for (const match of source.matchAll(numericZIndex)) {
    report(file, "numeric-z-index", match[0])
  }

  const normalized = file.split(sep).join("/")
  const domainShadow =
    normalized.includes("/components/mixer/") ||
    normalized.includes("/components/studio/") ||
    normalized.includes("/components/plugins/") ||
    normalized.includes("/components/performance/") ||
    normalized.includes("/components/benchmark/")

  if (!domainShadow) {
    for (const match of source.matchAll(/box-shadow\s*:\s*([^;]+);/gs)) {
      const value = match[1]?.trim() ?? ""
      if (value !== "none" && !/^var\(--ui-(?:shadow|focus-ring)/.test(value)) {
        report(file, "raw-shadow", value.replace(/\s+/g, " "))
      }
    }
  }
}

for (const file of uiFiles) {
  const normalized = file.split(sep).join("/")
  const source = readFileSync(file, "utf8")
  const isTokenSource =
    normalized.includes("/styles/tokens.css") ||
    normalized.includes("/styles/domain-palette.css") ||
    normalized.endsWith("/domainColors.ts")

  if (!isTokenSource) {
    for (const match of source.matchAll(rawColor)) {
      report(file, "raw-color", match[0])
    }
    for (const match of source.matchAll(numericZIndex)) {
      report(file, "numeric-z-index", match[0])
    }
  }

  if (/from\s+["'](?:pinia|vue-router|@yadaw\/contracts|electron)["']|window\.yadaw/.test(source)) {
    report(file, "ui-package-boundary", "UI primitives cannot depend on product state or runtime")
  }
}

const manifests = [
  join(workspaceRoot, "package.json"),
  ...collectPackageManifests(join(workspaceRoot, "apps")),
  ...collectPackageManifests(join(workspaceRoot, "packages"))
]

for (const manifest of manifests) {
  if (/histoire/i.test(readFileSync(manifest, "utf8"))) {
    report(manifest, "storybook-only", "Histoire dependencies and scripts are forbidden")
  }
}

if (failures.length > 0) {
  console.error(`Design audit failed with ${failures.length} violation(s):`)
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(
    `Design audit passed: ${rendererFiles.length} renderer sources and ${uiFiles.length} UI sources checked.`
  )
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

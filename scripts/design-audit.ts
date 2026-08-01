import { readdirSync, readFileSync, statSync } from "node:fs"
import { extname, join, relative, sep } from "node:path"

const workspaceRoot = process.cwd()
const rendererRoot = join(workspaceRoot, "apps/desktop/src/renderer/src")
const designSystemRoot = join(workspaceRoot, "apps/design-system/src")
const uiRoot = join(workspaceRoot, "packages/ui/src")
const sourceExtensions = new Set([".css", ".mdx", ".ts", ".vue"])
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
const designSystemFiles = collectFiles(designSystemRoot)
const uiFiles = collectFiles(uiRoot)
const tokenSourceFiles = [
  join(uiRoot, "styles/tokens.css"),
  join(uiRoot, "styles/domain-palette.css")
]
const definedUiTokens = new Set(
  tokenSourceFiles.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/(--ui-[\w-]+)\s*:/g)].flatMap((match) => {
      const token = match[1]
      return token === undefined ? [] : [token]
    })
  )
)
const rawColor = /#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)/gi
const numericZIndex = /z-index\s*:\s*-?\d+/gi
const typographyProperty =
  /\b(font-family|font-size|font-weight|line-height|letter-spacing)\s*:\s*([^;\r\n}"']+)/gi
const typographyInlineProperty =
  /\b(fontFamily|fontSize|fontWeight|lineHeight|letterSpacing)\s*:\s*["']([^"']+)["']/g
const fontShorthand = /(?<!-)\bfont\s*:\s*([^;}\r\n]+)/gi
const legacyTypographyToken =
  /var\(--(?:font-(?:sans|mono|display|utility)|ui-font-(?:sans|mono)|ui-weight-[\w-]+|ui-line-[\w-]+)\)/g

function auditTypography(file: string, source: string, isTokenSource = false): void {
  if (isTokenSource) return

  for (const match of source.matchAll(typographyProperty)) {
    const value = match[2]?.trim() ?? ""
    if (value !== "inherit" && !value.startsWith("var(") && !value.startsWith("clamp(var(")) {
      report(file, "raw-typography", `${match[1]}: ${value}`)
    }
  }

  for (const match of source.matchAll(typographyInlineProperty)) {
    const value = match[2]?.trim() ?? ""
    if (value !== "inherit" && !value.startsWith("var(") && !value.startsWith("clamp(var(")) {
      report(file, "raw-typography", `${match[1]}: ${value}`)
    }
  }

  for (const match of source.matchAll(fontShorthand)) {
    const value = match[1]?.trim() ?? ""
    const withoutTokens = value.replaceAll(/var\([^)]*\)/g, "")
    if (value !== "inherit" && /(?:\d|\bnormal\b|["'])/.test(withoutTokens)) {
      report(file, "raw-typography", `font: ${value}`)
    }
  }

  for (const match of source.matchAll(legacyTypographyToken)) {
    report(file, "legacy-typography-token", match[0])
  }
}

function auditTokenReferences(file: string, source: string): void {
  for (const match of source.matchAll(/var\((--ui-[\w-]+)/g)) {
    const token = match[1]
    if (token === undefined) continue
    if (!token.endsWith("-") && !definedUiTokens.has(token)) {
      report(file, "undefined-ui-token", token)
    }
  }
}

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
  auditTypography(file, source)
  auditTokenReferences(file, source)

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
  auditTypography(file, source, isTokenSource)
  auditTokenReferences(file, source)

  if (/from\s+["'](?:pinia|vue-router|@yadaw\/contracts|electron)["']|window\.yadaw/.test(source)) {
    report(file, "ui-package-boundary", "UI primitives cannot depend on product state or runtime")
  }
}

for (const file of designSystemFiles) {
  const source = readFileSync(file, "utf8")
  auditTypography(file, source)
  auditTokenReferences(file, source)
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
    `Design audit passed: ${rendererFiles.length} renderer, ${uiFiles.length} UI, and ${designSystemFiles.length} design-system sources checked.`
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

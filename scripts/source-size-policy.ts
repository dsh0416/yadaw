#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises"
import { extname, relative, resolve } from "node:path"
import { pathToFileURL } from "node:url"

export const REVIEW_LINE_LIMIT = 800
export const HARD_LINE_LIMIT = 1200

const SOURCE_ROOTS = ["apps", "packages", "crates", "scripts", "xtask"] as const
const SOURCE_EXTENSIONS = new Set([".rs", ".ts", ".tsx", ".vue"])
const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".vitepress",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "release",
  "target",
  "test-results",
  "third_party"
])

export type SourceSizeSeverity = "review" | "violation"

export interface SourceSizeFinding {
  path: string
  lines: number
  severity: SourceSizeSeverity
}

export function countPhysicalLines(source: string): number {
  if (source.length === 0) return 0
  const lines = source.split(/\r?\n/u).length
  return source.endsWith("\n") ? lines - 1 : lines
}

export function isTestOrGeneratedSource(path: string): boolean {
  const normalized = path.replaceAll("\\", "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  return (
    normalized.includes("/__tests__/") ||
    normalized.includes("/tests/") ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/u.test(name) ||
    name === "tests.rs" ||
    name.endsWith(".d.ts") ||
    normalized.includes("/generated/")
  )
}

export function classifySourceSize(path: string, source: string): SourceSizeFinding | null {
  if (isTestOrGeneratedSource(path)) return null
  const lines = countPhysicalLines(source)
  if (lines > HARD_LINE_LIMIT) return { path, lines, severity: "violation" }
  if (lines > REVIEW_LINE_LIMIT) return { path, lines, severity: "review" }
  return null
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectSourceFiles(path)))
    else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

export async function auditSourceSizes(workspaceRoot: string): Promise<SourceSizeFinding[]> {
  const files = (
    await Promise.all(SOURCE_ROOTS.map((root) => collectSourceFiles(resolve(workspaceRoot, root))))
  ).flat()
  const findings: SourceSizeFinding[] = []
  for (const file of files) {
    const path = relative(workspaceRoot, file).replaceAll("\\", "/")
    const finding = classifySourceSize(path, await readFile(file, "utf8"))
    if (finding) findings.push(finding)
  }
  return findings.sort(
    (left, right) => right.lines - left.lines || left.path.localeCompare(right.path)
  )
}

function printFindings(findings: SourceSizeFinding[]): void {
  if (findings.length === 0) {
    console.log("Source-size audit: no production file exceeds the review threshold.")
    return
  }
  console.log("severity\tlines\tpath")
  for (const finding of findings) {
    console.log(`${finding.severity}\t${finding.lines}\t${finding.path}`)
  }
  const reviews = findings.filter((finding) => finding.severity === "review").length
  const violations = findings.length - reviews
  console.log(`Source-size audit: ${violations} violation(s), ${reviews} review trigger(s).`)
}

async function checkNewFiles(workspaceRoot: string, paths: string[]): Promise<boolean> {
  let valid = true
  for (const input of paths) {
    const path = input.replaceAll("\\", "/")
    if (isTestOrGeneratedSource(path) || !SOURCE_EXTENSIONS.has(extname(path))) continue
    const lines = countPhysicalLines(await readFile(resolve(workspaceRoot, path), "utf8"))
    if (lines <= REVIEW_LINE_LIMIT) continue
    console.error(`New production source exceeds ${REVIEW_LINE_LIMIT} lines: ${lines}\t${path}`)
    valid = false
  }
  return valid
}

async function main(): Promise<void> {
  const workspaceRoot = process.cwd()
  const args = process.argv.slice(2)
  if (args[0] === "--check-new") {
    if (!(await checkNewFiles(workspaceRoot, args.slice(1)))) process.exitCode = 1
    return
  }

  const findings = await auditSourceSizes(workspaceRoot)
  printFindings(findings)
  if (args[0] === "--check" && findings.some((finding) => finding.severity === "violation")) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main()
}

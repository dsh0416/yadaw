#!/usr/bin/env node
/**
 * Rewrite Vitest lcov `SF:` paths so Codecov can attribute reports that are
 * generated from package cwd (`src/...`) back to repository-relative paths.
 *
 * Usage: node scripts/rewrite-lcov-paths.ts <lcov-path> [repo-relative-prefix]
 * Example: node scripts/rewrite-lcov-paths.ts packages/ui/coverage/lcov.info packages/ui/
 * Rust example: node scripts/rewrite-lcov-paths.ts coverage/rust/lcov.info
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/u, "")
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//u.test(path)
}

function pathWithinWorkspace(path: string, workspace: string): string | undefined {
  const windowsPath = /^[A-Za-z]:\//u.test(path)
  if (windowsPath !== /^[A-Za-z]:\//u.test(workspace)) return undefined

  const comparedPath = windowsPath ? path.toLocaleLowerCase("en-US") : path
  const comparedWorkspace = windowsPath ? workspace.toLocaleLowerCase("en-US") : workspace
  if (comparedPath === comparedWorkspace) return ""
  if (!comparedPath.startsWith(`${comparedWorkspace}/`)) return undefined
  return path.slice(workspace.length + 1)
}

export function rewriteLcovPaths(
  source: string,
  workspaceRoot: string,
  repoRelativePrefix = ""
): string {
  const workspace = normalizedPath(workspaceRoot)
  const prefix = normalizedPath(repoRelativePrefix).replace(/^\.\//u, "")

  return source
    .split("\n")
    .map((line) => {
      if (!line.startsWith("SF:")) return line

      const originalFile = line.slice(3)
      const file = normalizedPath(originalFile)
      if (isAbsolutePath(file)) {
        const relativeFile = pathWithinWorkspace(file, workspace)
        return relativeFile === undefined ? line : `SF:${relativeFile}`
      }

      const relativeFile = file.replace(/^\.\//u, "")
      if (!prefix || relativeFile === prefix || relativeFile.startsWith(`${prefix}/`)) {
        return `SF:${relativeFile}`
      }
      return `SF:${prefix}/${relativeFile}`
    })
    .join("\n")
}

function main(): void {
  const [, , lcovPathArg, prefixArg] = process.argv
  if (!lcovPathArg) {
    console.error("Usage: node scripts/rewrite-lcov-paths.ts <lcov-path> [repo-relative-prefix]")
    process.exitCode = 1
    return
  }

  const lcovPath = resolve(lcovPathArg)
  const workspaceRoot = process.env.GITHUB_WORKSPACE ?? process.cwd()
  const source = readFileSync(lcovPath, "utf8")
  writeFileSync(lcovPath, rewriteLcovPaths(source, workspaceRoot, prefixArg))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()

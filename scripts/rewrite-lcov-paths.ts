#!/usr/bin/env node
/**
 * Rewrite Vitest lcov `SF:` paths so Codecov can attribute reports that are
 * generated from package cwd (`src/...`) back to repository-relative paths.
 *
 * Usage: node scripts/rewrite-lcov-paths.ts <lcov-path> <repo-relative-prefix>
 * Example: node scripts/rewrite-lcov-paths.ts packages/ui/coverage/lcov.info packages/ui/
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const [, , lcovPathArg, prefixArg] = process.argv
if (!lcovPathArg || !prefixArg) {
  console.error(
    "Usage: node scripts/rewrite-lcov-paths.ts <lcov-path> <repo-relative-prefix>"
  )
  process.exit(1)
}

const lcovPath = resolve(lcovPathArg)
const prefix = prefixArg.endsWith("/") ? prefixArg : `${prefixArg}/`
const source = readFileSync(lcovPath, "utf8")
const rewritten = source
  .split("\n")
  .map((line) => {
    if (!line.startsWith("SF:")) return line
    const file = line.slice(3)
    if (file.startsWith(prefix) || file.startsWith("/")) return line
    return `SF:${prefix}${file}`
  })
  .join("\n")

writeFileSync(lcovPath, rewritten)

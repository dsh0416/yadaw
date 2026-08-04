#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(join(process.cwd(), "package.json"))
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs")
const result = spawnSync(process.execPath, [vitest, "run", "--coverage"], {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env
})

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)

if (result.error) {
  console.error(`Vitest coverage failed to start: ${result.error.message}`)
  process.exit(1)
}

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
if (/Failed to parse .*Excluding it from coverage\./su.test(output)) {
  console.error("Vitest excluded a source file after a coverage parse failure.")
  process.exit(1)
}

process.exit(result.status ?? 1)

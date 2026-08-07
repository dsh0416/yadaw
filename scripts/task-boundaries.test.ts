import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import test from "node:test"

const workspaceRoot = resolve(import.meta.dirname, "..")
const packageManifests = [
  "package.json",
  "apps/design-system/package.json",
  "apps/desktop/package.json",
  "apps/desktop/scripts/vst3-editor-smoke-app/package.json",
  "crates/dsp-node/package.json",
  "docs/package.json",
  "packages/contracts/package.json",
  "packages/project-db/package.json",
  "packages/project-model/package.json",
  "packages/ui/package.json"
]

await test("pnpm scripts remain JavaScript ecosystem leaf tasks", async () => {
  const violations: string[] = []
  const forbidden =
    /\b(?:cargo|rustc|rustup|mise)\b|scripts\/(?:cargo-host|native-build|rust-target|test-coverage)\.ts/u

  for (const manifest of packageManifests) {
    const source = await readFile(resolve(workspaceRoot, manifest), "utf8")
    const parsed = JSON.parse(source) as { scripts?: Record<string, string> }
    for (const [name, command] of Object.entries(parsed.scripts ?? {})) {
      if (forbidden.test(command)) violations.push(`${manifest}#${name}: ${command}`)
    }
  }

  assert.deepEqual(violations, [])
})

await test("xtask does not invoke JavaScript ecosystem tools", async () => {
  const source = await readFile(resolve(workspaceRoot, "xtask/src/lib.rs"), "utf8")
  assert.doesNotMatch(source, /Command::new\([^\n]*(?:node|pnpm)/u)
  assert.doesNotMatch(source, /CommandSpec[^\n]*(?:node|pnpm)/u)
})

await test("GitHub workflows use mise for repository task execution", async () => {
  const workflows = [
    ".github/workflows/build.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/test.yml"
  ]
  const forbidden = [
    "pnpm build:native",
    "pnpm docs:build",
    "pnpm ${{ matrix.check-script }}",
    "cargo build",
    "cargo truce build",
    "exec electron-builder"
  ]
  const violations: string[] = []

  for (const workflow of workflows) {
    const source = await readFile(resolve(workspaceRoot, workflow), "utf8")
    for (const command of forbidden) {
      if (source.includes(command)) violations.push(`${workflow}: ${command}`)
    }
  }

  assert.deepEqual(violations, [])
})

await test("universal macOS packaging includes only the universal DSP binding", async () => {
  const universalConfig = await readFile(
    resolve(workspaceRoot, "apps/desktop/electron-builder.universal.yml"),
    "utf8"
  )
  const releaseConfig = await readFile(
    resolve(workspaceRoot, "apps/desktop/electron-builder.release.yml"),
    "utf8"
  )
  const tasks = await readFile(resolve(workspaceRoot, "mise.toml"), "utf8")

  assert.match(universalConfig, /extends: \.\/electron-builder\.yml/u)
  assert.match(universalConfig, /\*\.darwin-arm64\.node/u)
  assert.match(universalConfig, /\*\.darwin-x64\.node/u)
  assert.match(releaseConfig, /extends: \.\/electron-builder\.universal\.yml/u)
  assert.match(tasks, /cargo xtask native universal-macos --profile release/u)
  assert.match(
    tasks,
    /electron-builder --config electron-builder\.universal\.yml --publish never --universal/u
  )
})

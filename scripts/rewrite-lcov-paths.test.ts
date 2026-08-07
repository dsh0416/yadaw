import assert from "node:assert/strict"
import test from "node:test"
import { rewriteLcovPaths } from "./rewrite-lcov-paths.ts"

await test("adds a package prefix exactly once", () => {
  assert.equal(
    rewriteLcovPaths(
      "SF:src/main.ts\nSF:apps/desktop/src/main.ts\n",
      "/workspace",
      "apps/desktop/"
    ),
    "SF:apps/desktop/src/main.ts\nSF:apps/desktop/src/main.ts\n"
  )
})

await test("rewrites POSIX workspace paths relative to the repository", () => {
  assert.equal(
    rewriteLcovPaths(
      "SF:/workspace/crates/audio-engine/src/lib.rs\n",
      "/workspace",
      "crates/audio-engine"
    ),
    "SF:crates/audio-engine/src/lib.rs\n"
  )
})

await test("rewrites Windows workspace paths case-insensitively with forward slashes", () => {
  assert.equal(
    rewriteLcovPaths("SF:D:\\A\\Yadaw\\crates\\audio-engine\\src\\lib.rs\n", "d:\\a\\yadaw"),
    "SF:crates/audio-engine/src/lib.rs\n"
  )
})

await test("keeps repository-relative Rust paths unprefixed", () => {
  assert.equal(
    rewriteLcovPaths("SF:crates/dsp-core/src/lib.rs\n", "/workspace"),
    "SF:crates/dsp-core/src/lib.rs\n"
  )
})

await test("does not remap absolute paths outside the workspace", () => {
  assert.equal(
    rewriteLcovPaths("SF:/opt/generated/source.rs\n", "/workspace", "crates/dsp-core"),
    "SF:/opt/generated/source.rs\n"
  )
})

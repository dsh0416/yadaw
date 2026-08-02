import assert from "node:assert/strict"
import test from "node:test"
import { ensureHostCargoTarget } from "./rust-target.ts"

await test("ensureHostCargoTarget injects the host target before cargo args end", () => {
  assert.deepEqual(ensureHostCargoTarget(["test", "--workspace"], "host-triple"), [
    "test",
    "--workspace",
    "--target",
    "host-triple"
  ])
})

await test("ensureHostCargoTarget injects before the binary-arg separator", () => {
  assert.deepEqual(
    ensureHostCargoTarget(["bench", "--workspace", "--", "--quick"], "host-triple"),
    ["bench", "--workspace", "--target", "host-triple", "--", "--quick"]
  )
})

await test("ensureHostCargoTarget ignores --target that appears only after --", () => {
  assert.deepEqual(
    ensureHostCargoTarget(["test", "--", "--target", "fixture-flag"], "host-triple"),
    ["test", "--target", "host-triple", "--", "--target", "fixture-flag"]
  )
})

await test("ensureHostCargoTarget leaves an explicit cargo --target alone", () => {
  assert.deepEqual(
    ensureHostCargoTarget(["build", "--target", "aarch64-apple-darwin"], "host-triple"),
    ["build", "--target", "aarch64-apple-darwin"]
  )
})

import assert from "node:assert/strict"
import test from "node:test"
import {
  HARD_LINE_LIMIT,
  REVIEW_LINE_LIMIT,
  classifySourceSize,
  countPhysicalLines,
  isTestOrGeneratedSource
} from "./source-size-policy.ts"

await test("counts physical lines without treating the final newline as another line", () => {
  assert.equal(countPhysicalLines(""), 0)
  assert.equal(countPhysicalLines("one"), 1)
  assert.equal(countPhysicalLines("one\ntwo\n"), 2)
  assert.equal(countPhysicalLines("one\r\ntwo\r\n"), 2)
})

await test("classifies production sources at the review and hard thresholds", () => {
  const review = classifySourceSize(
    "apps/desktop/src/feature.ts",
    "line\n".repeat(REVIEW_LINE_LIMIT + 1)
  )
  const violation = classifySourceSize(
    "crates/audio-engine/src/feature.rs",
    "line\n".repeat(HARD_LINE_LIMIT + 1)
  )

  assert.deepEqual(review, {
    path: "apps/desktop/src/feature.ts",
    lines: REVIEW_LINE_LIMIT + 1,
    severity: "review"
  })
  assert.deepEqual(violation, {
    path: "crates/audio-engine/src/feature.rs",
    lines: HARD_LINE_LIMIT + 1,
    severity: "violation"
  })
})

await test("does not report a production source at the review threshold", () => {
  assert.equal(
    classifySourceSize("packages/contracts/src/small.ts", "line\n".repeat(REVIEW_LINE_LIMIT)),
    null
  )
})

await test("exempts tests and generated declarations from the source-size policy", () => {
  for (const path of [
    "apps/desktop/src/feature.test.ts",
    "apps/desktop/e2e/feature.spec.ts",
    "packages/model/src/__tests__/large.ts",
    "crates/audio-engine/tests/large.rs",
    "crates/audio-engine/src/tests.rs",
    "crates/dsp-node/index.d.ts",
    "packages/contracts/src/generated/schema.ts"
  ]) {
    assert.equal(isTestOrGeneratedSource(path), true, path)
    assert.equal(classifySourceSize(path, "line\n".repeat(HARD_LINE_LIMIT + 1)), null)
  }
})

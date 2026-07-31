import { describe, expect, it } from "vitest"
import { IPC_PROTOCOL_VERSION } from "@yadaw/contracts"
import type { ResourceRef, RpcRequestMeta } from "@yadaw/contracts"
import {
  revisionConflictFailure,
  sameResourceRef,
  staleResourceFailure,
  validateMutationTarget,
  validateReadTarget,
  validationFailure
} from "./resource-validation"

const target: ResourceRef = {
  kind: "project-graph",
  id: "project:graph",
  epoch: "epoch-1",
  generation: 2
}

function meta(overrides: Partial<RpcRequestMeta> = {}): RpcRequestMeta {
  return {
    protocolVersion: IPC_PROTOCOL_VERSION,
    requestId: "request-1",
    ...overrides
  }
}

describe("sameResourceRef", () => {
  it("matches identical resource identities", () => {
    expect(sameResourceRef(target, { ...target })).toBe(true)
  })

  it("rejects undefined left or mismatched fields", () => {
    expect(sameResourceRef(undefined, target)).toBe(false)
    expect(sameResourceRef({ ...target, kind: "project-session" }, target)).toBe(false)
    expect(sameResourceRef({ ...target, id: "other" }, target)).toBe(false)
    expect(sameResourceRef({ ...target, epoch: "other" }, target)).toBe(false)
    expect(sameResourceRef({ ...target, generation: 99 }, target)).toBe(false)
  })
})

describe("validationFailure", () => {
  it("returns a validation RpcFailure without a resource when meta has no target", () => {
    const result = validationFailure(meta(), "mutation")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.requestId).toBe("request-1")
    expect(result.error).toMatchObject({
      code: "validation-failed",
      category: "validation",
      outcome: "not-committed",
      retry: "never",
      userMessageKey: "errors.invalidRpcRequest",
      details: { type: "validation-failed", field: "mutation" }
    })
    expect(result.error.correlationId).toEqual(expect.any(String))
    expect(result.error.resource).toBeUndefined()
  })

  it("includes meta.target when present", () => {
    const result = validationFailure(meta({ target }), "expectedRevision")

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.resource).toEqual(target)
    expect(result.error.details).toEqual({ type: "validation-failed", field: "expectedRevision" })
  })
})

describe("staleResourceFailure", () => {
  it("prefers meta.target and falls back to the provided target", () => {
    const withMetaTarget = staleResourceFailure(meta({ target }), {
      ...target,
      id: "fallback"
    })
    expect(withMetaTarget.ok).toBe(false)
    if (withMetaTarget.ok) return
    expect(withMetaTarget.error).toMatchObject({
      code: "stale-resource",
      category: "stale-resource",
      outcome: "not-committed",
      retry: "after-reconcile",
      userMessageKey: "errors.staleResource",
      resource: target,
      details: { type: "stale-resource", reason: "generation-mismatch" }
    })

    const withoutMetaTarget = staleResourceFailure(meta(), target)
    expect(withoutMetaTarget.ok).toBe(false)
    if (withoutMetaTarget.ok) return
    expect(withoutMetaTarget.error.resource).toEqual(target)
  })
})

describe("revisionConflictFailure", () => {
  it("reports expected and actual revisions", () => {
    const result = revisionConflictFailure(meta({ expectedRevision: 3, target }), target, 7)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toMatchObject({
      code: "revision-conflict",
      category: "conflict",
      outcome: "not-committed",
      retry: "after-reconcile",
      resource: target,
      details: {
        type: "revision-conflict",
        expectedRevision: 3,
        actualRevision: 7
      }
    })
  })

  it("uses -1 when expectedRevision is absent", () => {
    const result = revisionConflictFailure(meta(), target, 4)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.details).toEqual({
      type: "revision-conflict",
      expectedRevision: -1,
      actualRevision: 4
    })
  })
})

describe("validateReadTarget", () => {
  it("rejects mutation metas", () => {
    const result = validateReadTarget(
      meta({
        target,
        mutation: { operationId: "op-1", idempotencyKey: "idem-1" }
      }),
      target
    )

    expect(result?.ok).toBe(false)
    if (!result || result.ok) return
    expect(result.error.code).toBe("validation-failed")
    expect(result.error.details).toEqual({ type: "validation-failed", field: "mutation" })
  })

  it("rejects stale targets", () => {
    const result = validateReadTarget(meta({ target: { ...target, generation: 1 } }), target)

    expect(result?.ok).toBe(false)
    if (!result || result.ok) return
    expect(result.error.code).toBe("stale-resource")
  })

  it("accepts a matching read target", () => {
    expect(validateReadTarget(meta({ target }), target)).toBeNull()
  })
})

describe("validateMutationTarget", () => {
  it("rejects non-mutation metas", () => {
    const result = validateMutationTarget(meta({ target }), target)

    expect(result?.ok).toBe(false)
    if (!result || result.ok) return
    expect(result.error.code).toBe("validation-failed")
    expect(result.error.details).toEqual({ type: "validation-failed", field: "mutation" })
  })

  it("rejects stale targets", () => {
    const result = validateMutationTarget(
      meta({
        target: { ...target, epoch: "stale" },
        mutation: { operationId: "op-1", idempotencyKey: "idem-1" }
      }),
      target
    )

    expect(result?.ok).toBe(false)
    if (!result || result.ok) return
    expect(result.error.code).toBe("stale-resource")
  })

  it("rejects revision conflicts when an actual revision is supplied", () => {
    const result = validateMutationTarget(
      meta({
        target,
        expectedRevision: 2,
        mutation: { operationId: "op-1", idempotencyKey: "idem-1" }
      }),
      target,
      5
    )

    expect(result?.ok).toBe(false)
    if (!result || result.ok) return
    expect(result.error.code).toBe("revision-conflict")
    expect(result.error.details).toEqual({
      type: "revision-conflict",
      expectedRevision: 2,
      actualRevision: 5
    })
  })

  it("accepts matching mutation targets with or without revision checks", () => {
    const mutationMeta = meta({
      target,
      expectedRevision: 4,
      mutation: { operationId: "op-1", idempotencyKey: "idem-1" }
    })

    expect(validateMutationTarget(mutationMeta, target)).toBeNull()
    expect(validateMutationTarget(mutationMeta, target, 4)).toBeNull()
  })
})

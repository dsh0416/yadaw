import type { ResourceKind, ResourceRef } from "@yadaw/contracts"
import { kernelFailure, kernelSuccess } from "./result"
import type { KernelResult } from "./result"

export type ResourceStatus = "candidate" | "committed" | "quarantined" | "dropped"
export type ResourceDisposer = () => Promise<void> | void
export type QuarantinePolicy = "retain-for-reaping" | "drop-observations"

export interface ResourceRecord<Snapshot = unknown> {
  ref: ResourceRef
  parent?: ResourceRef
  revision: number
  status: ResourceStatus
  committedSnapshot?: Snapshot
  quarantinePolicy: QuarantinePolicy
}

interface StoredResourceRecord extends ResourceRecord {
  disposer?: ResourceDisposer
}

export type ResourceRegistryError =
  | {
      code: "stale-resource"
      reason: "missing" | "epoch-mismatch" | "generation-mismatch" | "parent-invalid"
      resource: ResourceRef
    }
  | {
      code: "revision-conflict"
      resource: ResourceRef
      expectedRevision: number
      actualRevision: number
    }
  | {
      code: "invalid-transition"
      resource: ResourceRef
      from: ResourceStatus
      to: ResourceStatus
    }

export interface CreateResourceOptions {
  kind: ResourceKind
  id: string
  parent?: ResourceRef
  disposer?: ResourceDisposer
  quarantinePolicy?: QuarantinePolicy
}

export interface DropResourceSummary {
  dropped: ResourceRef[]
  quarantined: ResourceRef[]
}

function logicalKey(kind: ResourceKind, id: string): string {
  return `${kind}:${id}`
}

function refKey(ref: ResourceRef): string {
  return `${ref.epoch}:${ref.kind}:${ref.id}:${ref.generation}`
}

function cloneRecord<Snapshot>(record: StoredResourceRecord): ResourceRecord<Snapshot> {
  return structuredClone({
    ref: record.ref,
    ...(record.parent ? { parent: record.parent } : {}),
    revision: record.revision,
    status: record.status,
    ...(record.committedSnapshot === undefined
      ? {}
      : { committedSnapshot: record.committedSnapshot }),
    quarantinePolicy: record.quarantinePolicy
  }) as ResourceRecord<Snapshot>
}

export class ResourceRegistry {
  private readonly records = new Map<string, StoredResourceRecord>()
  private readonly generations = new Map<string, number>()

  constructor(readonly epoch: string) {}

  create(options: CreateResourceOptions): KernelResult<ResourceRecord, ResourceRegistryError> {
    if (options.parent) {
      const parent = this.resolveStored(options.parent)
      if (
        !parent.ok ||
        (parent.value.status !== "candidate" && parent.value.status !== "committed")
      ) {
        return kernelFailure({
          code: "stale-resource",
          reason: "parent-invalid",
          resource: structuredClone(options.parent)
        })
      }
    }

    const key = logicalKey(options.kind, options.id)
    const generation = (this.generations.get(key) ?? 0) + 1
    this.generations.set(key, generation)
    const ref: ResourceRef = {
      kind: options.kind,
      id: options.id,
      epoch: this.epoch,
      generation
    }
    const record: StoredResourceRecord = {
      ref,
      ...(options.parent ? { parent: structuredClone(options.parent) } : {}),
      revision: 0,
      status: "candidate",
      ...(options.disposer ? { disposer: options.disposer } : {}),
      quarantinePolicy: options.quarantinePolicy ?? "retain-for-reaping"
    }
    this.records.set(refKey(ref), record)
    return kernelSuccess(cloneRecord(record))
  }

  resolve<Snapshot>(
    ref: ResourceRef,
    allowedStatuses: readonly ResourceStatus[] = ["committed"]
  ): KernelResult<ResourceRecord<Snapshot>, ResourceRegistryError> {
    const result = this.resolveStored(ref)
    if (!result.ok) return result
    if (!allowedStatuses.includes(result.value.status)) {
      return kernelFailure({
        code: "stale-resource",
        reason: result.value.parent ? "parent-invalid" : "generation-mismatch",
        resource: structuredClone(ref)
      })
    }
    if (result.value.parent) {
      const parent = this.resolveStored(result.value.parent)
      if (!parent.ok || parent.value.status !== "committed") {
        return kernelFailure({
          code: "stale-resource",
          reason: "parent-invalid",
          resource: structuredClone(ref)
        })
      }
    }
    return kernelSuccess(cloneRecord<Snapshot>(result.value))
  }

  commit<Snapshot>(
    ref: ResourceRef,
    snapshot: Snapshot
  ): KernelResult<ResourceRecord<Snapshot>, ResourceRegistryError> {
    const result = this.resolveStored(ref)
    if (!result.ok) return result
    const record = result.value
    if (record.status !== "candidate") {
      return kernelFailure({
        code: "invalid-transition",
        resource: structuredClone(ref),
        from: record.status,
        to: "committed"
      })
    }
    if (record.parent) {
      const parent = this.resolveStored(record.parent)
      if (!parent.ok || parent.value.status !== "committed") {
        return kernelFailure({
          code: "stale-resource",
          reason: "parent-invalid",
          resource: structuredClone(ref)
        })
      }
    }
    record.status = "committed"
    record.revision = 1
    record.committedSnapshot = structuredClone(snapshot)
    return kernelSuccess(cloneRecord<Snapshot>(record))
  }

  update<Snapshot>(
    ref: ResourceRef,
    expectedRevision: number,
    snapshot: Snapshot
  ): KernelResult<ResourceRecord<Snapshot>, ResourceRegistryError> {
    const result = this.resolveStored(ref)
    if (!result.ok) return result
    const record = result.value
    if (record.status !== "committed") {
      return kernelFailure({
        code: "invalid-transition",
        resource: structuredClone(ref),
        from: record.status,
        to: "committed"
      })
    }
    if (record.revision !== expectedRevision) {
      return kernelFailure({
        code: "revision-conflict",
        resource: structuredClone(ref),
        expectedRevision,
        actualRevision: record.revision
      })
    }
    record.revision += 1
    record.committedSnapshot = structuredClone(snapshot)
    return kernelSuccess(cloneRecord<Snapshot>(record))
  }

  quarantine(ref: ResourceRef): KernelResult<ResourceRecord, ResourceRegistryError> {
    const result = this.resolveStored(ref)
    if (!result.ok) return result
    const record = result.value
    if (record.status === "dropped") {
      return kernelFailure({
        code: "invalid-transition",
        resource: structuredClone(ref),
        from: record.status,
        to: "quarantined"
      })
    }
    record.status = "quarantined"
    return kernelSuccess(cloneRecord(record))
  }

  async drop(ref: ResourceRef): Promise<KernelResult<DropResourceSummary, ResourceRegistryError>> {
    const root = this.resolveStored(ref)
    if (!root.ok) return root
    const selected = new Set<string>([refKey(ref)])
    let changed = true
    while (changed) {
      changed = false
      for (const [key, record] of this.records) {
        if (record.parent && selected.has(refKey(record.parent)) && !selected.has(key)) {
          selected.add(key)
          changed = true
        }
      }
    }

    const ordered = [...selected]
      .map((key) => this.records.get(key))
      .filter((record): record is StoredResourceRecord => record !== undefined)
      .sort((left, right) => this.depth(right) - this.depth(left))

    for (const record of ordered) record.status = "dropped"

    const summary: DropResourceSummary = { dropped: [], quarantined: [] }
    for (const record of ordered) {
      try {
        await record.disposer?.()
        summary.dropped.push(structuredClone(record.ref))
      } catch {
        record.status = "quarantined"
        summary.quarantined.push(structuredClone(record.ref))
      }
    }
    return kernelSuccess(summary)
  }

  snapshot(): ResourceRecord[] {
    return [...this.records.values()].map((record) => cloneRecord(record))
  }

  private resolveStored(
    ref: ResourceRef
  ): KernelResult<StoredResourceRecord, ResourceRegistryError> {
    if (ref.epoch !== this.epoch) {
      return kernelFailure({
        code: "stale-resource",
        reason: "epoch-mismatch",
        resource: structuredClone(ref)
      })
    }
    const exact = this.records.get(refKey(ref))
    if (exact) return kernelSuccess(exact)
    const logical = logicalKey(ref.kind, ref.id)
    const knownGeneration = this.generations.get(logical)
    return kernelFailure({
      code: "stale-resource",
      reason: knownGeneration === undefined ? "missing" : "generation-mismatch",
      resource: structuredClone(ref)
    })
  }

  private depth(record: StoredResourceRecord): number {
    let depth = 0
    let parent = record.parent
    while (parent) {
      depth += 1
      parent = this.records.get(refKey(parent))?.parent
    }
    return depth
  }
}

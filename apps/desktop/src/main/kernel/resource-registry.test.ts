import { describe, expect, it, vi } from "vitest"
import { ResourceRegistry } from "./resource-registry"

function committedRoot(registry: ResourceRegistry) {
  const candidate = registry.create({
    kind: "desktop-session",
    id: "desktop"
  })
  expect(candidate.ok).toBe(true)
  if (!candidate.ok) throw new Error("test setup failed")
  const committed = registry.commit(candidate.value.ref, { ready: true })
  expect(committed.ok).toBe(true)
  if (!committed.ok) throw new Error("test setup failed")
  return committed.value
}

describe("ResourceRegistry", () => {
  it("rejects stale epochs and generations before mutation", () => {
    const registry = new ResourceRegistry("epoch-2")
    const root = committedRoot(registry)

    expect(registry.resolve({ ...root.ref, epoch: "epoch-1" })).toMatchObject({
      ok: false,
      error: { code: "stale-resource", reason: "epoch-mismatch" }
    })
    expect(registry.update({ ...root.ref, generation: 99 }, 1, { ready: false })).toMatchObject({
      ok: false,
      error: { code: "stale-resource", reason: "generation-mismatch" }
    })
    expect(registry.resolve(root.ref)).toMatchObject({
      ok: true,
      value: { revision: 1, committedSnapshot: { ready: true } }
    })
  })

  it("enforces revision conflicts without changing the committed snapshot", () => {
    const registry = new ResourceRegistry("epoch")
    const root = committedRoot(registry)

    expect(registry.update(root.ref, 0, { ready: false })).toMatchObject({
      ok: false,
      error: { code: "revision-conflict", expectedRevision: 0, actualRevision: 1 }
    })
    expect(registry.resolve(root.ref)).toMatchObject({
      ok: true,
      value: { revision: 1, committedSnapshot: { ready: true } }
    })
  })

  it("builds an isolated candidate subtree before committing its parent", () => {
    const registry = new ResourceRegistry("epoch")
    const root = committedRoot(registry)
    const project = registry.create({
      kind: "project-session",
      id: "project",
      parent: root.ref
    })
    expect(project.ok).toBe(true)
    if (!project.ok) throw new Error("test setup failed")
    const graph = registry.create({
      kind: "project-graph",
      id: "graph",
      parent: project.value.ref
    })
    expect(graph.ok).toBe(true)
    if (!graph.ok) throw new Error("test setup failed")

    expect(registry.resolve(project.value.ref)).toMatchObject({
      ok: false,
      error: { code: "stale-resource" }
    })
    expect(registry.commit(project.value.ref, { name: "Project" }).ok).toBe(true)
    expect(registry.commit(graph.value.ref, { revision: 1 }).ok).toBe(true)
  })

  it("atomically invalidates descendants and quarantines only failed cleanup", async () => {
    const registry = new ResourceRegistry("epoch")
    const root = committedRoot(registry)
    const childCleanup = vi.fn()
    const child = registry.create({
      kind: "project-session",
      id: "project",
      parent: root.ref,
      disposer: childCleanup
    })
    expect(child.ok).toBe(true)
    if (!child.ok) throw new Error("test setup failed")
    expect(registry.commit(child.value.ref, { name: "Project" }).ok).toBe(true)
    const grandchild = registry.create({
      kind: "project-graph",
      id: "graph",
      parent: child.value.ref,
      disposer: () => {
        throw new Error("worker already exited")
      }
    })
    expect(grandchild.ok).toBe(true)
    if (!grandchild.ok) throw new Error("test setup failed")
    expect(registry.commit(grandchild.value.ref, { revision: 1 }).ok).toBe(true)

    const pendingDrop = registry.drop(root.ref)
    expect(registry.resolve(child.value.ref)).toMatchObject({
      ok: false,
      error: { code: "stale-resource" }
    })
    const result = await pendingDrop

    expect(result).toMatchObject({
      ok: true,
      value: {
        dropped: expect.arrayContaining([root.ref, child.value.ref]),
        quarantined: [grandchild.value.ref]
      }
    })
    expect(childCleanup).toHaveBeenCalledOnce()
  })

  it("never reuses a generation after drop", async () => {
    const registry = new ResourceRegistry("epoch")
    const root = committedRoot(registry)
    await registry.drop(root.ref)
    const replacement = registry.create({ kind: "desktop-session", id: "desktop" })

    expect(replacement).toMatchObject({
      ok: true,
      value: { ref: { generation: 2 } }
    })
  })
})

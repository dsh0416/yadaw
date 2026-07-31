import { describe, expect, it, vi } from "vitest"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type { ProjectSession } from "@yadaw/contracts"
import { ApplicationStateStore } from "./application-state-store"
import { OperationRegistry } from "./operation-registry"

const project: ProjectSession = {
  id: "project",
  path: "project.yadaw",
  configuration: {
    name: "Project",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  },
  dirty: false,
  recoveredWorkingCopy: false
}

describe("ApplicationStateStore", () => {
  it("creates committed desktop and settings roots in one main epoch", () => {
    const created = ApplicationStateStore.create({
      epoch: "epoch-1",
      project: null
    })

    expect(created).toMatchObject({
      ok: true,
      value: {
        desktopSession: {
          kind: "desktop-session",
          epoch: "epoch-1",
          generation: 1
        },
        applicationSettings: {
          kind: "application-settings",
          epoch: "epoch-1",
          generation: 1
        }
      }
    })
    if (!created.ok) throw new Error("test setup failed")
    expect(created.value.resources.resolve(created.value.applicationSettings).ok).toBe(true)
  })

  it("owns revisioned lifecycle state and publishes cloned projections", () => {
    const created = ApplicationStateStore.create({
      epoch: "epoch-1",
      project: null
    })
    if (!created.ok) throw new Error("test setup failed")
    const store = created.value
    const listener = vi.fn()
    store.subscribe(listener)

    store.setProject({ status: "open", session: project, error: null })
    project.configuration.name = "Mutated outside"

    expect(store.lifecycleSnapshot()).toMatchObject({
      revision: 1,
      project: {
        status: "open",
        session: { configuration: { name: "Project" } }
      }
    })
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "project", revision: 1 }))
  })

  it("produces a complete main snapshot with operation retention metrics", () => {
    const created = ApplicationStateStore.create({
      epoch: "epoch-1",
      project: null,
      runtime: { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, state: "running" }
    })
    if (!created.ok) throw new Error("test setup failed")
    const operations = new OperationRegistry()
    operations.begin({
      operationId: "operation-1",
      idempotencyKey: "start",
      target: created.value.desktopSession
    })

    expect(created.value.snapshot(operations)).toMatchObject({
      protocolVersion: 2,
      mainEpoch: "epoch-1",
      lifecycle: {
        audio: { status: "running" }
      },
      operations: {
        active: 1,
        retainedTerminal: 0
      }
    })
  })
})

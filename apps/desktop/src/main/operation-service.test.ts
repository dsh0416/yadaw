import { beforeEach, describe, expect, it, vi } from "vitest"
import type { DesktopSessionRef, OperationSnapshot } from "@yadaw/contracts"

vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => []
  }
}))

import { OperationService } from "./operation-service"
import { OperationRegistry } from "./kernel/operation-registry"

const runningOperation: OperationSnapshot = {
  id: "recording:1",
  title: "Finalizing recording",
  phase: "closing-recording",
  state: "running",
  completedUnits: null,
  totalUnits: null,
  cancellable: false,
  error: null,
  dropoutFrames: 0
}
const desktopSession: DesktopSessionRef = {
  kind: "desktop-session",
  id: "desktop",
  epoch: "main-epoch",
  generation: 1
}

describe("OperationService", () => {
  let service: OperationService

  beforeEach(() => {
    service = new OperationService(new OperationRegistry(), desktopSession)
  })

  it("counts only operations that are still running", () => {
    service.upsert(runningOperation)
    expect(service.activeCount).toBe(1)

    service.patch(runningOperation.id, { state: "completed" })
    expect(service.activeCount).toBe(0)

    service.upsert({ ...runningOperation, id: "save:1", state: "failed" })
    expect(service.activeCount).toBe(0)
  })
})

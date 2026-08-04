import { describe, expect, it } from "vitest"
import { ProjectWorkspaceOwnership } from "./project-workspace-ownership"

describe("ProjectWorkspaceOwnership", () => {
  it("keeps a candidate isolated until commit", () => {
    const ownership = new ProjectWorkspaceOwnership<{ id: string }>()
    ownership.stage({ id: "candidate" })

    expect(ownership.active).toBeNull()
    expect(ownership.requireCandidate().id).toBe("candidate")
    expect(ownership.commitCandidate().id).toBe("candidate")
    expect(ownership.active?.id).toBe("candidate")
    expect(ownership.candidate).toBeNull()
  })

  it("rolls a failed candidate back without touching the active workspace", () => {
    const ownership = new ProjectWorkspaceOwnership<{ id: string }>()
    ownership.stage({ id: "broken" })
    expect(ownership.takeCandidate()?.id).toBe("broken")
    expect(ownership.active).toBeNull()

    ownership.stage({ id: "healthy" })
    ownership.commitCandidate()
    expect(() => ownership.stage({ id: "other" })).toThrow(
      "Close the current project before opening another"
    )
  })
})

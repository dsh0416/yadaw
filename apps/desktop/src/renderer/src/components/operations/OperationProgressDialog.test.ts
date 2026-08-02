import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import OperationProgressDialog from "./OperationProgressDialog.vue"

describe("OperationProgressDialog", () => {
  it("exposes determinate progress and a cancellable action", async () => {
    const wrapper = mount(OperationProgressDialog, {
      props: {
        operation: {
          id: "import",
          title: "Import",
          phase: "writing-large-object",
          state: "running",
          completedUnits: 50,
          totalUnits: 100,
          cancellable: true,
          error: null,
          dropoutFrames: 0
        }
      }
    })
    expect(wrapper.get(".operation-description").text()).toBe("Import · Writing project asset")
    expect(wrapper.find("h3").exists()).toBe(false)
    expect(wrapper.text()).not.toContain("In progress")
    expect(wrapper.get("[role=progressbar]").attributes("aria-valuenow")).toBe("50")
    expect(wrapper.text()).not.toContain("50%")
    await wrapper.get("button").trigger("click")
    expect(wrapper.emitted("cancel")).toHaveLength(1)
  })

  it("makes commit indeterminate and non-cancellable, then reports dropout warnings", () => {
    const wrapper = mount(OperationProgressDialog, {
      props: {
        operation: {
          id: "commit",
          title: "Commit",
          phase: "committing-database",
          state: "running",
          completedUnits: null,
          totalUnits: null,
          cancellable: false,
          error: null,
          dropoutFrames: 8
        }
      }
    })
    expect(wrapper.get("[role=progressbar]").classes()).toContain("ui-progress--indeterminate")
    expect(wrapper.find("button").exists()).toBe(false)
    expect(wrapper.get(".operation-description").text()).toBe(
      "Commit · 8 captured frames were dropped."
    )
  })

  it("renders a successful terminal operation without a close button", () => {
    const wrapper = mount(OperationProgressDialog, {
      props: {
        operation: {
          id: "done",
          title: "Finalize",
          phase: "committing-database",
          state: "completed",
          completedUnits: null,
          totalUnits: null,
          cancellable: false,
          error: null,
          dropoutFrames: 0
        }
      }
    })
    expect(wrapper.get(".operation-description").text()).toBe("Finalize · Completed")
    expect(wrapper.get("[role=progressbar]").attributes("aria-valuenow")).toBe("100")
    expect(wrapper.find("button").exists()).toBe(false)
  })

  it("folds a failure into the single compact description", () => {
    const wrapper = mount(OperationProgressDialog, {
      props: {
        operation: {
          id: "failed",
          title: "Opening project",
          phase: "loading-project-archive",
          state: "failed",
          completedUnits: 1,
          totalUnits: 5,
          cancellable: false,
          error: {
            code: "resource-unavailable",
            category: "unavailable",
            outcome: "not-committed",
            retry: "safe",
            correlationId: "open-failed",
            userMessageKey: "errors.operationFailed",
            details: {
              type: "resource-unavailable",
              component: "project-worker",
              dispatched: true
            }
          },
          dropoutFrames: 0
        }
      }
    })

    expect(wrapper.get(".operation-description").text()).toBe(
      "Opening project · The operation could not be completed."
    )
    expect(wrapper.get(".operation-description").classes()).toContain(
      "operation-description--danger"
    )
    expect(wrapper.find("[role=alert]").exists()).toBe(false)
  })

  it("labels project opening phases and exposes step progress", () => {
    const wrapper = mount(OperationProgressDialog, {
      props: {
        operation: {
          id: "open-project",
          title: "Opening project",
          description: "Demo",
          phase: "loading-mixer",
          state: "running",
          completedUnits: 2,
          totalUnits: 4,
          cancellable: false,
          error: null,
          dropoutFrames: 0
        }
      }
    })
    expect(wrapper.get(".operation-description").text()).toBe("Opening project · Loading mixer")
    expect(wrapper.text()).not.toContain("50%")
    expect(wrapper.find("h3").exists()).toBe(false)
    expect(wrapper.get("[role=progressbar]").attributes("aria-label")).toBe("Loading mixer")
  })
})

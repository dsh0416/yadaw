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
          message: null,
          dropoutFrames: 0
        }
      }
    })
    expect(wrapper.get("[role=progressbar]").attributes("aria-valuenow")).toBe("50")
    expect(wrapper.text()).toContain("50%")
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
          message: null,
          dropoutFrames: 8
        }
      }
    })
    expect(wrapper.get("[role=progressbar]").classes()).toContain("indeterminate")
    expect(wrapper.find("button").exists()).toBe(false)
    expect(wrapper.text()).toContain("8 captured frames were dropped")
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
          message: null,
          dropoutFrames: 0
        }
      }
    })
    expect(wrapper.text()).toContain("Completed")
    expect(wrapper.get("[role=progressbar]").attributes("aria-valuenow")).toBe("100")
    expect(wrapper.find("button").exists()).toBe(false)
  })

  it("labels project opening phases and exposes step progress", () => {
    const wrapper = mount(OperationProgressDialog, {
      props: {
        operation: {
          id: "open-project",
          title: "Opening Demo",
          phase: "loading-mixer",
          state: "running",
          completedUnits: 2,
          totalUnits: 4,
          cancellable: false,
          message: null,
          dropoutFrames: 0
        }
      }
    })
    expect(wrapper.text()).toContain("Loading mixer")
    expect(wrapper.text()).toContain("50%")
    expect(wrapper.get("[role=progressbar]").attributes("aria-label")).toBe("Loading mixer")
  })
})

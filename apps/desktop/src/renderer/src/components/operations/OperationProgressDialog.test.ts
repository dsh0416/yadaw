import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import OperationProgressDialog from "./OperationProgressDialog.vue"

describe("OperationProgressDialog", () => {
  it("exposes determinate progress and a cancellable action", async () => {
    const wrapper = mount(OperationProgressDialog, { props: { operation: {
      id: "import", title: "Import", phase: "writing-large-object", state: "running",
      completedBytes: 50, totalBytes: 100, cancellable: true, message: null, dropoutFrames: 0
    } } })
    expect(wrapper.get("[role=progressbar]").attributes("aria-valuenow")).toBe("50")
    await wrapper.get("button").trigger("click")
    expect(wrapper.emitted("cancel")).toHaveLength(1)
  })

  it("makes commit indeterminate and non-cancellable, then reports dropout warnings", () => {
    const wrapper = mount(OperationProgressDialog, { props: { operation: {
      id: "commit", title: "Commit", phase: "committing-database", state: "running",
      completedBytes: null, totalBytes: null, cancellable: false, message: null, dropoutFrames: 8
    } } })
    expect(wrapper.get("[role=progressbar]").classes()).toContain("indeterminate")
    expect(wrapper.get("button").attributes("disabled")).toBeDefined()
    expect(wrapper.text()).toContain("8 captured frames were dropped")
  })

  it("renders a successful terminal operation as completed at 100 percent", async () => {
    const wrapper = mount(OperationProgressDialog, { props: { operation: {
      id: "done", title: "Finalize", phase: "committing-database", state: "completed",
      completedBytes: null, totalBytes: null, cancellable: false, message: null, dropoutFrames: 0
    } } })
    expect(wrapper.text()).toContain("Completed")
    expect(wrapper.get("[role=progressbar]").attributes("aria-valuenow")).toBe("100")
    await wrapper.get("button").trigger("click")
    expect(wrapper.emitted("dismiss")).toHaveLength(1)
  })
})

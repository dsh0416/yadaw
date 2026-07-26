import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import GlobalDialogHost from "./GlobalDialogHost.vue"
import { useGlobalDialog } from "../../composables/useGlobalDialog"

describe("GlobalDialogHost", () => {
  it("renders a destructive confirmation in a portal and resolves its action", async () => {
    const wrapper = mount(GlobalDialogHost, { attachTo: document.body })
    const { confirm } = useGlobalDialog()

    const result = confirm({
      eyebrow: "Mixer routing",
      tone: "danger",
      title: "Delete Vocals?",
      description: "Its clips will be removed from the timeline.",
      confirmLabel: "Delete channel",
      destructive: true
    })
    await wrapper.vm.$nextTick()

    const dialog = document.body.querySelector<HTMLElement>("[role=alertdialog]")
    expect(dialog?.textContent).toContain("Delete Vocals?")
    expect(dialog?.dataset.tone).toBe("danger")

    const deleteButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Delete channel"
    )
    deleteButton?.click()

    await expect(result).resolves.toBe(true)
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector("[role=alertdialog]")).toBeNull()
    wrapper.unmount()
  })

  it("queues dialogs and resolves Escape-style dismissal with the cancel value", async () => {
    const wrapper = mount(GlobalDialogHost, { attachTo: document.body })
    const { showDialog, dismissDialog } = useGlobalDialog()
    const first = showDialog({
      title: "First",
      description: "First dialog",
      actions: [{ value: "done", label: "Done", kind: "primary" }],
      cancelValue: "cancel"
    })
    const second = showDialog({
      title: "Second",
      description: "Second dialog",
      actions: [{ value: "done", label: "Done", kind: "primary" }],
      cancelValue: "cancel"
    })
    await wrapper.vm.$nextTick()

    expect(document.body.querySelector("[role=alertdialog]")?.textContent).toContain("First")
    dismissDialog()
    await expect(first).resolves.toBe("cancel")
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await wrapper.vm.$nextTick()
    expect(document.body.querySelector("[role=alertdialog]")?.textContent).toContain("Second")

    dismissDialog()
    await expect(second).resolves.toBe("cancel")
    wrapper.unmount()
  })
})

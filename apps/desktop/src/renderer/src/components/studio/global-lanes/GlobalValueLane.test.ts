import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import GlobalValueLane from "./GlobalValueLane.vue"

function mountLane() {
  const wrapper = mount(GlobalValueLane, {
    props: {
      points: [
        { id: "start", position: 0, value: 120, lockTime: true, lockRemoval: true },
        { id: "change", position: 2, value: 140 }
      ],
      selectedId: "change",
      contentWidth: 800,
      pixelsPerUnit: 100,
      height: 100,
      minimum: 80,
      maximum: 160,
      guides: [160, 120, 80],
      verticalGuides: [0, 100, 200],
      color: "#65A8FF",
      expanded: true,
      valueLabel: "Tempo",
      positionLabel: "beats"
    }
  })
  const editor = wrapper.get<HTMLElement>('[role="application"]')
  editor.element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 800,
    bottom: 100,
    width: 800,
    height: 100,
    toJSON: () => ({})
  })
  return { wrapper, editor }
}

describe("GlobalValueLane", () => {
  it("renders a stepped value curve and creates points from the lane surface", async () => {
    const { wrapper, editor } = mountLane()

    expect(wrapper.get(".lane-line").attributes("d")).toBe("M 0 50 H 200 V 25 H 800")

    await editor.trigger("dblclick", { clientX: 350, clientY: 75 })
    expect(wrapper.emitted("create")?.[0]).toEqual([3.5, 100])
  })

  it("deletes the selected editable point but preserves locked points", async () => {
    const { wrapper, editor } = mountLane()

    await editor.trigger("keydown", { key: "Delete" })
    expect(wrapper.emitted("remove")?.[0]).toEqual(["change"])

    await wrapper.setProps({ selectedId: "start" })
    await editor.trigger("keydown", { key: "Backspace" })
    expect(wrapper.emitted("remove")).toHaveLength(1)
  })
})

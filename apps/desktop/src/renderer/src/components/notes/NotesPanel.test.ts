import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { nextTick } from "vue"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EMPTY_PROJECT_GRAPH } from "../../stores/projectGraph"
import { useMixerStore } from "../../stores/mixer"
import { useStudioWorkspaceStore } from "../../stores/studioWorkspace"
import NotesPanel from "./NotesPanel.vue"

enableAutoUnmount(afterEach)

const channel = {
  id: "audio-1",
  kind: "audio" as const,
  systemRole: null,
  name: "Lead vocal",
  color: "#4F8CFF",
  sortOrder: 0,
  inputSource: "hardware" as const,
  inputFormat: "mono" as const,
  gainDb: 0,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: null,
  outputBus: 1,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1],
  hardwareOutputChannels: []
}

function setup() {
  const pinia = createPinia()
  setActivePinia(pinia)
  const mixer = useMixerStore()
  const workspace = useStudioWorkspaceStore()
  workspace.reset()
  mixer.hydrate({
    ...structuredClone(EMPTY_PROJECT_GRAPH),
    projectNotes:
      "# Session plan\n\n**Keep this take.**\n\n[Website](https://example.com)\n\n![Remote image](https://example.com/image.png)\n\n<script>bad()</script>",
    tracks: [{ id: "track-1", channelId: channel.id, sortOrder: 0, notes: "Use the **47**." }],
    channels: [channel]
  })
  mixer.selectedChannelId = channel.id
  const execute = vi.spyOn(mixer, "execute").mockResolvedValue(true)
  const wrapper = mount(NotesPanel, { global: { plugins: [pinia] } })
  return { wrapper, mixer, workspace, execute }
}

describe("NotesPanel", () => {
  it("renders sanitized project Markdown and switches to the selected track notes", async () => {
    const { wrapper } = setup()

    const preview = wrapper.get('[data-testid="markdown-preview"]')
    expect(preview.text()).toContain("Session plan")
    expect(preview.get("strong").text()).toBe("Keep this take.")
    expect(preview.text()).toContain("Website")
    expect(preview.find("a").exists()).toBe(false)
    expect(preview.find("img").exists()).toBe(false)
    expect(preview.find("script").exists()).toBe(false)

    await wrapper.findAll('[role="tab"]')[1]!.trigger("click")
    expect(wrapper.get('[data-testid="markdown-preview"]').text()).toContain("Use the 47.")
    expect(wrapper.text()).toContain("Lead vocal")
  })

  it("edits and saves project and track Markdown through project commands", async () => {
    const { wrapper, execute } = setup()

    await wrapper.get('button[class="edit-button"]').trigger("click")
    await wrapper.get("textarea").setValue("## Revised plan")
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save")!
      .trigger("click")
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith({
      type: "update-project-notes",
      notes: "## Revised plan"
    })

    await wrapper.findAll('[role="tab"]')[1]!.trigger("click")
    await wrapper.get('button[class="edit-button"]').trigger("click")
    await wrapper.get("textarea").setValue("Track detail")
    await wrapper.get("textarea").trigger("keydown", { key: "s", ctrlKey: true })
    await flushPromises()
    expect(execute).toHaveBeenLastCalledWith({
      type: "update-track",
      trackId: "track-1",
      patch: { notes: "Track detail" }
    })
  })

  it("explains that track notes need a selected timeline track", async () => {
    const { wrapper, mixer } = setup()
    mixer.selectedChannelId = null
    await wrapper.findAll('[role="tab"]')[1]!.trigger("click")

    expect(wrapper.text()).toContain("Select an Audio or Instrument track")
    expect(wrapper.find("textarea").exists()).toBe(false)
  })

  it("switches back to project notes, cancels empty-state editing, and closes the panel", async () => {
    const { wrapper, mixer, workspace } = setup()

    await wrapper.findAll('[role="tab"]')[1]!.trigger("click")
    await wrapper.findAll('[role="tab"]')[0]!.trigger("click")
    expect(wrapper.get('[data-testid="markdown-preview"]').text()).toContain("Session plan")

    mixer.hydrate({ ...structuredClone(mixer.graph), projectNotes: "" })
    await nextTick()
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Start writing")!
      .trigger("click")
    expect(wrapper.find("textarea").exists()).toBe(true)
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Cancel")!
      .trigger("click")
    expect(wrapper.find("textarea").exists()).toBe(false)

    workspace.toggleNotesPanel()
    expect(workspace.notesPanelOpen).toBe(true)
    await wrapper.get('button[aria-label="Close notes"]').trigger("click")
    expect(workspace.notesPanelOpen).toBe(false)
  })

  it("saves track notes to the track that was active when editing began", async () => {
    const { wrapper, mixer, execute } = setup()
    const secondChannel = { ...channel, id: "audio-2", name: "Harmony" }
    mixer.hydrate({
      ...structuredClone(mixer.graph),
      tracks: [
        ...mixer.graph.tracks,
        { id: "track-2", channelId: secondChannel.id, sortOrder: 1, notes: "Harmony note" }
      ],
      channels: [...mixer.graph.channels, secondChannel]
    })

    await wrapper.findAll('[role="tab"]')[1]!.trigger("click")
    await wrapper.get('button[class="edit-button"]').trigger("click")
    await wrapper.get("textarea").setValue("Lead vocal edit")
    mixer.selectedChannelId = secondChannel.id
    await nextTick()
    await wrapper
      .findAll("button")
      .find((button) => button.text() === "Save")!
      .trigger("click")
    await flushPromises()

    expect(execute).toHaveBeenLastCalledWith({
      type: "update-track",
      trackId: "track-1",
      patch: { notes: "Lead vocal edit" }
    })
  })
})

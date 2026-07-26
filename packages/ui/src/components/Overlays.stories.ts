import { expect, userEvent, within } from "storybook/test"
import type { Meta, StoryObj } from "@storybook/vue3-vite"

import UiAlertDialog from "./UiAlertDialog.vue"
import UiButton from "./UiButton.vue"
import UiDialog from "./UiDialog.vue"
import UiPopover from "./UiPopover.vue"

const meta = {
  title: "Components/Overlays/Dialog",
  component: UiDialog,
  tags: ["autodocs"],
  args: {
    title: "Dialog"
  },
  render: () => ({
    components: { UiButton, UiDialog },
    template: `
      <UiDialog title="Import MIDI file" description="Choose how the selected MIDI tracks should be added.">
        <template #trigger><UiButton variant="primary">Open import dialog</UiButton></template>
        <p style="margin:0;color:var(--ui-color-text-muted)">Two tracks and four tempo events were found.</p>
        <template #actions>
          <UiButton>Cancel</UiButton>
          <UiButton variant="primary">Import tracks</UiButton>
        </template>
      </UiDialog>
    `
  })
} satisfies Meta<typeof UiDialog>

export default meta
type Story = StoryObj<typeof meta>

export const Interactive: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Open import dialog" }))

    const page = within(canvasElement.ownerDocument.body)
    await expect(page.getByRole("dialog", { name: "Import MIDI file" })).toBeVisible()
    await userEvent.keyboard("{Escape}")
    await expect(page.queryByRole("dialog", { name: "Import MIDI file" })).toBeNull()
  }
}

export const DestructiveConfirmation: Story = {
  render: () => ({
    components: { UiAlertDialog, UiButton },
    data: () => ({ open: true }),
    template: `
      <UiAlertDialog
        v-model="open"
        title="Delete recording?"
        description="This removes the take from the project. The source file cannot be restored from YADAW."
        confirm-label="Delete recording"
        tone="danger"
      >
        <template #trigger><UiButton variant="danger">Delete take</UiButton></template>
      </UiAlertDialog>
    `
  })
}

export const Popover: Story = {
  render: () => ({
    components: { UiButton, UiPopover },
    template: `
      <UiPopover align="start">
        <template #trigger><UiButton>Routing</UiButton></template>
        <div class="storybook-stack" style="min-width:16rem">
          <strong>Output routing</strong>
          <span style="color:var(--ui-color-text-muted)">Main output · Stereo</span>
        </div>
      </UiPopover>
    `
  })
}

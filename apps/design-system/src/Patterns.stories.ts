import type { Meta, StoryObj } from "@storybook/vue3-vite"

import {
  UiAlertDialog,
  UiButton,
  UiEmptyState,
  UiLoadingState,
  UiStatusNotice,
  UiSurface
} from "@heron/ui"

const meta = {
  title: "Patterns/Async states",
  component: UiLoadingState,
  tags: ["autodocs"],
  args: {
    title: "Loading"
  }
} satisfies Meta<typeof UiLoadingState>

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {
  render: () => ({
    components: { UiLoadingState, UiSurface },
    template: `
      <UiSurface style="max-width:42rem">
        <UiLoadingState title="Scanning audio plug-ins" description="Validating 18 of 42 plug-ins. You can continue editing while the scan runs." :value="43" />
      </UiSurface>
    `
  })
}

export const Empty: Story = {
  render: () => ({
    components: { UiButton, UiEmptyState, UiSurface },
    template: `
      <UiSurface style="max-width:42rem">
        <UiEmptyState title="No MIDI devices found" description="Connect a device, then rescan from MIDI settings.">
          <template #actions><UiButton variant="primary">Rescan devices</UiButton></template>
        </UiEmptyState>
      </UiSurface>
    `
  })
}

export const Error: Story = {
  render: () => ({
    components: { UiButton, UiStatusNotice },
    template: `
      <UiStatusNotice tone="danger" title="Project could not be saved" live="assertive">
        The project folder is no longer writable.
        <div style="margin-top:var(--ui-space-3)"><UiButton size="sm">Choose another folder</UiButton></div>
      </UiStatusNotice>
    `
  })
}

export const DestructiveConfirmation: Story = {
  render: () => ({
    components: { UiAlertDialog, UiButton },
    data: () => ({ open: false }),
    template: `
      <UiAlertDialog v-model="open" title="Discard pending recording?" description="The current take has not been added to the project." tone="danger" confirm-label="Discard take">
        <template #trigger><UiButton variant="danger">Discard take</UiButton></template>
      </UiAlertDialog>
    `
  })
}

export const LongRunningOperation: Story = {
  render: () => ({
    components: { UiButton, UiLoadingState, UiSurface },
    template: `
      <UiSurface style="max-width:42rem">
        <UiLoadingState title="Consolidating audio" description="Copying referenced files into the project. Keep Heron open until this finishes." :value="68" />
        <div style="display:flex;justify-content:center;padding-bottom:var(--ui-space-5)"><UiButton>Run in background</UiButton></div>
      </UiSurface>
    `
  })
}

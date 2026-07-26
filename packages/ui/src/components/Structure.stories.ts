import type { Meta, StoryObj } from "@storybook/vue3-vite"

import UiButton from "./UiButton.vue"
import UiSectionHeading from "./UiSectionHeading.vue"
import UiSurface from "./UiSurface.vue"

const meta = {
  title: "Components/Structure/Surface",
  component: UiSurface,
  tags: ["autodocs"],
  render: () => ({
    components: { UiButton, UiSectionHeading, UiSurface },
    template: `
      <div class="storybook-grid">
        <UiSurface v-for="level in ['canvas', 'base', 'raised']" :key="level" :level="level">
          <UiSectionHeading :title="level + ' surface'" description="Stable structure without product behavior.">
            <template #actions><UiButton size="sm">Action</UiButton></template>
          </UiSectionHeading>
        </UiSurface>
      </div>
    `
  })
} satisfies Meta<typeof UiSurface>

export default meta
type Story = StoryObj<typeof meta>

export const Levels: Story = {}

export const LongTextAtNarrowWidth: Story = {
  render: () => ({
    components: { UiButton, UiSectionHeading, UiSurface },
    template: `
      <div style="width:20rem;max-width:100%">
        <UiSurface>
          <UiSectionHeading
            title="Audio input and output configuration"
            description="Select a device, sample rate, and buffer size. Changes briefly suspend audio processing."
          >
            <template #actions><UiButton size="sm">Apply configuration</UiButton></template>
          </UiSectionHeading>
        </UiSurface>
      </div>
    `
  })
}

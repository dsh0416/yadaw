import type { Meta, StoryObj } from "@storybook/vue3-vite"

import UiButton from "./UiButton.vue"
import UiIconButton from "./UiIconButton.vue"
import UiTooltip from "./UiTooltip.vue"

const meta = {
  title: "Components/Actions/Button",
  component: UiButton,
  tags: ["autodocs"],
  args: {
    variant: "secondary",
    size: "md",
    disabled: false,
    loading: false
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["primary", "secondary", "ghost", "danger"]
    },
    size: {
      control: "select",
      options: ["sm", "md", "lg"]
    }
  },
  render: (args) => ({
    components: { UiButton },
    setup: () => ({ args }),
    template: `<UiButton v-bind="args">Save project</UiButton>`
  })
} satisfies Meta<typeof UiButton>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const Loading: Story = {
  args: {
    loading: true,
    loadingLabel: "Saving project"
  }
}

export const Disabled: Story = {
  args: {
    disabled: true
  }
}

export const Danger: Story = {
  args: {
    variant: "danger"
  },
  render: (args) => ({
    components: { UiButton },
    setup: () => ({ args }),
    template: `<UiButton v-bind="args">Delete recording permanently</UiButton>`
  })
}

export const AllVariantsAndSizes: Story = {
  render: () => ({
    components: { UiButton, UiIconButton, UiTooltip },
    template: `
      <div class="storybook-stack">
        <div v-for="size in ['sm', 'md', 'lg']" :key="size" style="display:flex;flex-wrap:wrap;gap:var(--ui-space-3);align-items:center">
          <UiButton v-for="variant in ['primary', 'secondary', 'ghost', 'danger']" :key="variant" :size="size" :variant="variant">
            {{ variant }}
          </UiButton>
        </div>
        <div style="display:flex;gap:var(--ui-space-3)">
          <UiIconButton label="Toggle metronome" :pressed="true"><span aria-hidden="true">M</span></UiIconButton>
          <UiTooltip text="Arm track" shortcut="R"><UiButton size="sm">Record arm</UiButton></UiTooltip>
        </div>
      </div>
    `
  })
}

export const LongText: Story = {
  render: (args) => ({
    components: { UiButton },
    setup: () => ({ args }),
    template: `
      <div style="max-width:20rem">
        <UiButton v-bind="args">Save this project and all referenced audio files</UiButton>
      </div>
    `
  })
}

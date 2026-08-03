import type { Meta, StoryObj } from "@storybook/vue3-vite"
import AsioCompatibleLogo from "./AsioCompatibleLogo.vue"

const meta = {
  title: "Foundations/Brand/ASIO Compatible Logo",
  component: AsioCompatibleLogo,
  tags: ["autodocs"],
  args: {
    decorative: false
  },
  render: (args) => ({
    components: { AsioCompatibleLogo },
    setup: () => ({ args }),
    template: `
      <div
        :style="{
          display: 'inline-block',
          padding: 'var(--ui-space-6)',
          background: 'var(--ui-palette-neutral-950)'
        }"
      >
        <AsioCompatibleLogo v-bind="args" style="--asio-compatible-logo-width:32mm" />
      </div>
    `
  })
} satisfies Meta<typeof AsioCompatibleLogo>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

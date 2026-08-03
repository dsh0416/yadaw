import type { Meta, StoryObj } from "@storybook/vue3-vite"
import VstCompatibleLogo from "./VstCompatibleLogo.vue"

const meta = {
  title: "Foundations/Brand/VST Compatible Logo",
  component: VstCompatibleLogo,
  tags: ["autodocs"],
  args: {
    appearance: "on-dark",
    decorative: false
  },
  argTypes: {
    appearance: {
      control: "select",
      options: ["on-dark", "on-light"]
    }
  },
  render: (args) => ({
    components: { VstCompatibleLogo },
    setup: () => ({ args }),
    template: `
      <div
        :style="{
          display: 'inline-block',
          padding: 'var(--ui-space-6)',
          background:
            args.appearance === 'on-dark'
              ? 'var(--ui-palette-neutral-950)'
              : 'var(--ui-palette-neutral-50)'
        }"
      >
        <VstCompatibleLogo v-bind="args" style="--vst-compatible-logo-width:24mm" />
      </div>
    `
  })
} satisfies Meta<typeof VstCompatibleLogo>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

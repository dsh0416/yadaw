import type { Meta, StoryObj } from "@storybook/vue3-vite"

import YadawLogo from "./YadawLogo.vue"

const meta = {
  title: "Foundations/Brand/Logo",
  component: YadawLogo,
  tags: ["autodocs"],
  args: {
    variant: "lockup",
    decorative: false
  },
  argTypes: {
    variant: {
      control: "select",
      options: ["lockup", "mark", "wordmark"]
    }
  },
  render: (args) => ({
    components: { YadawLogo },
    setup: () => ({ args }),
    template: `
      <YadawLogo
        v-bind="args"
        style="--yadaw-logo-highlight:var(--ui-signal-midi);color:var(--ui-signal-audio);font-size:3rem"
      />
    `
  })
} satisfies Meta<typeof YadawLogo>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const OfficialVariants: Story = {
  render: () => ({
    components: { YadawLogo },
    template: `
      <div style="display:grid;gap:var(--ui-space-8)">
        <div v-for="variant in ['lockup', 'mark', 'wordmark']" :key="variant" style="display:grid;gap:var(--ui-space-2)">
          <span style="color:var(--ui-color-text-subtle);font:var(--ui-font-size-xs) var(--ui-font-mono);text-transform:uppercase">{{ variant }}</span>
          <YadawLogo
            :variant="variant"
            style="--yadaw-logo-highlight:var(--ui-signal-midi);color:var(--ui-signal-audio);font-size:3rem"
          />
        </div>
      </div>
    `
  })
}

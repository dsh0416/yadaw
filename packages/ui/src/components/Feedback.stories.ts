import type { Meta, StoryObj } from "@storybook/vue3-vite"

import UiButton from "./UiButton.vue"
import UiEmptyState from "./UiEmptyState.vue"
import UiLoadingState from "./UiLoadingState.vue"
import UiProgress from "./UiProgress.vue"
import UiSpinner from "./UiSpinner.vue"
import UiStatusNotice from "./UiStatusNotice.vue"

const meta = {
  title: "Components/Feedback/Status",
  component: UiStatusNotice,
  tags: ["autodocs"],
  render: () => ({
    components: {
      UiButton,
      UiEmptyState,
      UiLoadingState,
      UiProgress,
      UiSpinner,
      UiStatusNotice
    },
    template: `
      <div class="storybook-stack">
        <UiStatusNotice tone="info" title="Audio engine ready">ASIO · 48 kHz · 256 samples</UiStatusNotice>
        <UiStatusNotice tone="success" title="Project saved">All referenced audio is up to date.</UiStatusNotice>
        <UiStatusNotice tone="warning" title="High buffer usage">Consider freezing processor-heavy tracks.</UiStatusNotice>
        <UiStatusNotice tone="danger" title="Audio device disconnected" live="assertive">Reconnect the device or choose another output.</UiStatusNotice>
        <UiProgress :value="62" label="Rendering stems" value-text="62 percent" />
        <UiProgress :value="null" label="Scanning plug-ins" />
        <UiSpinner label="Loading mixer" />
      </div>
    `
  })
} satisfies Meta<typeof UiStatusNotice>

export default meta
type Story = StoryObj<typeof meta>

export const StatusAndProgress: Story = {}

export const Loading: Story = {
  render: () => ({
    components: { UiLoadingState },
    template: `<UiLoadingState title="Opening project" description="Restoring tracks, routing, and plug-in state." :value="44" />`
  })
}

export const Empty: Story = {
  render: () => ({
    components: { UiButton, UiEmptyState },
    template: `
      <UiEmptyState title="No recent projects" description="Create a project or open an existing YADAW session to begin.">
        <template #icon><span style="font-size:var(--ui-type-size-page-title)">♪</span></template>
        <template #actions><UiButton variant="primary">Create project</UiButton><UiButton>Open project</UiButton></template>
      </UiEmptyState>
    `
  })
}

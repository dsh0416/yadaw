import type { Meta, StoryObj } from "@storybook/vue3-vite"

import UiCheckbox from "./UiCheckbox.vue"
import UiField from "./UiField.vue"
import UiRadioGroup from "./UiRadioGroup.vue"
import UiSelect from "./UiSelect.vue"
import UiSlider from "./UiSlider.vue"
import UiTextInput from "./UiTextInput.vue"

const meta = {
  title: "Components/Forms/Field",
  component: UiField,
  tags: ["autodocs"],
  args: {
    label: "Field"
  },
  render: () => ({
    components: {
      UiCheckbox,
      UiField,
      UiRadioGroup,
      UiSelect,
      UiSlider,
      UiTextInput
    },
    data: () => ({
      projectName: "Midnight session",
      driver: "asio",
      monitoring: true,
      mode: "balanced",
      bufferSize: 256,
      driverOptions: [
        { label: "ASIO", value: "asio" },
        { label: "WASAPI", value: "wasapi" }
      ],
      modeOptions: [
        {
          label: "Low latency",
          value: "low",
          description: "Prioritizes live monitoring response."
        },
        {
          label: "Balanced",
          value: "balanced",
          description: "Recommended for editing and mixing."
        }
      ]
    }),
    template: `
      <form class="storybook-stack" style="max-width:32rem" @submit.prevent>
        <UiField label="Project name" description="Shown in the project browser." required>
          <template #default="{ controlId, descriptionId }">
            <UiTextInput v-model="projectName" :id="controlId" :aria-describedby="descriptionId" />
          </template>
        </UiField>
        <UiField label="Audio driver">
          <template #default="{ controlId }">
            <UiSelect v-model="driver" :id="controlId" :options="driverOptions" />
          </template>
        </UiField>
        <UiCheckbox v-model="monitoring" label="Software monitoring" description="Hear armed inputs through YADAW." />
        <UiRadioGroup v-model="mode" label="Performance profile" :options="modeOptions" />
        <UiField label="Buffer size" description="Lower values reduce latency and increase CPU demand.">
          <template #default="{ controlId, descriptionId }">
            <UiSlider v-model="bufferSize" :id="controlId" :aria-describedby="descriptionId" label="Buffer size" :min="32" :max="2048" :step="32" :value-text="bufferSize + ' samples'" />
          </template>
        </UiField>
      </form>
    `
  })
} satisfies Meta<typeof UiField>

export default meta
type Story = StoryObj<typeof meta>

export const CompleteForm: Story = {}

export const Error: Story = {
  render: () => ({
    components: { UiField, UiTextInput },
    data: () => ({ value: "" }),
    template: `
      <div style="max-width:28rem">
        <UiField label="Project name" error="Enter a project name before continuing." required>
          <template #default="{ controlId, errorId }">
            <UiTextInput v-model="value" :id="controlId" :aria-describedby="errorId" invalid />
          </template>
        </UiField>
      </div>
    `
  })
}

export const Disabled: Story = {
  render: () => ({
    components: { UiCheckbox, UiField, UiSelect, UiTextInput },
    data: () => ({
      value: "Unavailable device",
      selected: "offline",
      options: [{ label: "Device offline", value: "offline", disabled: true }]
    }),
    template: `
      <div class="storybook-stack" style="max-width:28rem">
        <UiField label="Device name"><template #default="{ controlId }"><UiTextInput v-model="value" :id="controlId" disabled /></template></UiField>
        <UiField label="Audio device">
          <template #default="{ controlId }">
            <UiSelect v-model="selected" :id="controlId" :options="options" disabled />
          </template>
        </UiField>
        <UiCheckbox label="Exclusive device access" disabled />
      </div>
    `
  })
}

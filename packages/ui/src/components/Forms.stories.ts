import type { Meta, StoryObj } from "@storybook/vue3-vite"

import UiCascadingSelect from "./UiCascadingSelect.vue"
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

export const SelectSizesAndGroups: Story = {
  render: () => ({
    components: { UiCascadingSelect, UiField, UiSelect },
    data: () => ({
      compactValue: "post",
      standardValue: "asio",
      keyValue: "major:0",
      routeValue: "output",
      inputValue: "1",
      routingOptions: [
        { label: "Pre-fader", value: "pre" },
        { label: "Post-fader", value: "post" },
        { label: "Post-pan", value: "post-pan" }
      ],
      driverOptions: [
        { label: "ASIO", value: "asio" },
        { label: "WASAPI", value: "wasapi" }
      ],
      keyGroups: [
        {
          label: "Major keys",
          options: [
            { label: "C♯ Major", value: "major:7" },
            { label: "C Major", value: "major:0" },
            { label: "C♭ Major", value: "major:-7" }
          ]
        },
        {
          label: "Minor keys",
          separatorBefore: true,
          options: [
            { label: "A♯ minor", value: "minor:7" },
            { label: "A minor", value: "minor:0" },
            { label: "A♭ minor", value: "minor:-7" }
          ]
        }
      ],
      routeGroups: [
        {
          label: "Outputs",
          options: [
            { label: "Output 1–2", value: "output" },
            { label: "Headphones 3–4", value: "headphones" }
          ]
        },
        {
          label: "Buses",
          options: [
            { label: "Reverb", value: "reverb" },
            { label: "Parallel compression", value: "parallel" }
          ]
        }
      ],
      inputOptions: [
        { label: "IN 1–2", value: "1" },
        { label: "IN 3–4", value: "3" },
        { label: "IN 5–6", value: "5" },
        { label: "IN 7–8", value: "7" }
      ]
    }),
    template: `
      <div class="storybook-stack" style="max-width:28rem">
        <UiField label="Compact · timeline and mixer">
          <template #default="{ controlId }">
            <UiSelect v-model="compactValue" :id="controlId" :options="routingOptions" size="compact" />
          </template>
        </UiField>
        <UiField label="Small · preference rows">
          <template #default="{ controlId }">
            <UiSelect v-model="standardValue" :id="controlId" :options="driverOptions" size="sm" />
          </template>
        </UiField>
        <UiField label="Medium · project forms">
          <template #default="{ controlId }">
            <UiSelect v-model="standardValue" :id="controlId" :options="driverOptions" size="md" />
          </template>
        </UiField>
        <UiField label="Large · spacious forms">
          <template #default="{ controlId }">
            <UiSelect v-model="standardValue" :id="controlId" :options="driverOptions" size="lg" />
          </template>
        </UiField>
        <UiField label="Grouped values">
          <template #default="{ controlId }">
            <UiSelect v-model="keyValue" :id="controlId" :groups="keyGroups" size="md" />
          </template>
        </UiField>
        <UiField label="Cascading route">
          <template #default="{ controlId }">
            <UiCascadingSelect v-model="routeValue" :id="controlId" :groups="routeGroups" size="compact" />
          </template>
        </UiField>
        <UiField label="Direct menu">
          <template #default="{ controlId }">
            <UiCascadingSelect v-model="inputValue" :id="controlId" :options="inputOptions" size="compact" />
          </template>
        </UiField>
      </div>
    `
  })
}

export const EmbeddedHoverTreatments: Story = {
  render: () => ({
    components: { UiCascadingSelect },
    data: () => ({
      hostTintValue: "input:1",
      surfaceValue: "input:1",
      options: [
        { label: "IN 1–2", value: "input:1" },
        { label: "IN 3–4", value: "input:3" }
      ]
    }),
    template: `
      <div class="storybook-stack" style="max-width:28rem">
        <div style="overflow:hidden;border-radius:var(--ui-radius-sm);color:white;background:linear-gradient(var(--ui-domain-color-3f91d4),var(--ui-domain-color-2871ae))">
          <UiCascadingSelect v-model="hostTintValue" :options="options" size="compact" appearance="embedded" hover-treatment="host-tint" aria-label="Host tint embedded hover" />
        </div>
        <div style="overflow:hidden;border-radius:var(--ui-radius-sm);color:white;background:linear-gradient(var(--ui-domain-color-3f91d4),var(--ui-domain-color-2871ae))">
          <UiCascadingSelect v-model="surfaceValue" :options="options" size="compact" appearance="embedded" hover-treatment="surface" aria-label="Surface embedded hover" />
        </div>
      </div>
    `
  })
}

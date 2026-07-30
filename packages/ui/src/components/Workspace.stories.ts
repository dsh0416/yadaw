import type { Meta, StoryObj } from "@storybook/vue3-vite"

import UiButton from "./UiButton.vue"
import UiChoiceChip from "./UiChoiceChip.vue"
import UiField from "./UiField.vue"
import UiNumberInput from "./UiNumberInput.vue"
import UiSegmentedControl from "./UiSegmentedControl.vue"
import UiSelect from "./UiSelect.vue"
import UiToolbar from "./UiToolbar.vue"

const meta = {
  title: "Components/Workspace/Command surfaces",
  component: UiToolbar,
  tags: ["autodocs"],
  args: {
    label: "Workspace commands"
  },
  parameters: {
    layout: "fullscreen"
  }
} satisfies Meta<typeof UiToolbar>

export default meta
type Story = StoryObj<typeof meta>

export const EditorToolbar: Story = {
  render: () => ({
    components: {
      UiButton,
      UiChoiceChip,
      UiSegmentedControl,
      UiSelect,
      UiToolbar
    },
    data: () => ({
      tool: "select",
      snap: "1/16",
      tools: [
        { label: "Select", value: "select" },
        { label: "Draw", value: "draw" },
        { label: "Erase", value: "erase" }
      ],
      snapOptions: [
        { label: "1/8", value: "1/8" },
        { label: "1/16", value: "1/16" },
        { label: "1/32", value: "1/32" }
      ],
      clips: [
        { name: "Verse", color: "var(--ui-signal-midi)" },
        { name: "Counter melody", color: "var(--ui-signal-audio)" }
      ],
      activeClip: "Verse"
    }),
    template: `
      <UiToolbar density="compact" label="Piano roll commands">
        <template #start>
          <UiSegmentedControl v-model="tool" size="compact" label="Editing tool" :options="tools" />
          <label class="workspace-story-field">
            <span>Snap</span>
            <UiSelect v-model="snap" size="compact" :options="snapOptions" aria-label="Snap resolution" />
          </label>
        </template>
        <div class="workspace-story-clips" aria-label="Open clips">
          <UiChoiceChip
            v-for="clip in clips"
            :key="clip.name"
            :label="clip.name"
            :selected="activeClip === clip.name"
            :signal-color="clip.color"
            @select="activeClip = clip.name"
          />
        </div>
        <template #end><UiButton size="sm" variant="ghost">Close editor</UiButton></template>
      </UiToolbar>
    `
  })
}

export const InspectorFields: Story = {
  render: () => ({
    components: { UiField, UiNumberInput },
    data: () => ({ pitch: 60, velocity: 96 }),
    template: `
      <aside class="workspace-story-inspector" aria-label="Selected note properties">
        <strong>1 note selected</strong>
        <UiField label="Pitch" layout="inline">
          <template #default="{ controlId }">
            <UiNumberInput v-model="pitch" :id="controlId" size="compact" :min="0" :max="127" />
          </template>
        </UiField>
        <UiField label="Velocity" layout="inline">
          <template #default="{ controlId }">
            <UiNumberInput v-model="velocity" :id="controlId" size="compact" :min="1" :max="127" />
          </template>
        </UiField>
      </aside>
    `
  })
}

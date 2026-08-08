import type { Meta, StoryObj } from "@storybook/vue3-vite"
import { expect, fireEvent, userEvent, within } from "storybook/test"

import UiLevelMeter from "./UiLevelMeter.vue"
import UiMixerStateButton from "./UiMixerStateButton.vue"
import UiRotaryControl from "./UiRotaryControl.vue"
import UiVerticalFader from "./UiVerticalFader.vue"

const meta = {
  title: "Components/Workspace/Mixer controls",
  component: UiRotaryControl,
  tags: ["autodocs"],
  args: {
    value: 0,
    min: -64,
    max: 63,
    step: 1,
    defaultValue: 0,
    label: "Pan",
    bipolarCenter: 0,
    accent: "var(--ui-signal-meter-safe)"
  }
} satisfies Meta<typeof UiRotaryControl>

export default meta
type Story = StoryObj<typeof meta>

export const Pan: Story = {
  render: () => ({
    components: { UiRotaryControl },
    data: () => ({ pan: 0 }),
    methods: {
      panText(value: number) {
        if (value === 0) return "Center"
        return value < 0 ? `${Math.abs(value)} left` : `${value} right`
      }
    },
    template: `
      <UiRotaryControl
        :value="pan"
        :min="-64"
        :max="63"
        :step="1"
        :default-value="0"
        :bipolar-center="0"
        label="Pan"
        value-label="Pan value"
        :value-text="panText"
        accent="var(--ui-signal-meter-safe)"
        @preview="pan = $event"
        @commit="pan = $event"
      />
    `
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const pan = canvas.getByRole("slider", { name: "Pan" })
    await fireEvent.input(pan, { target: { value: "1" } })
    await fireEvent.change(pan, { target: { value: "1" } })
    await expect(pan).toHaveAttribute("aria-valuetext", "1 right")
    await userEvent.dblClick(pan)
    await expect(pan).toHaveAttribute("aria-valuetext", "Center")
  }
}

export const LogicSendPositions: Story = {
  render: () => ({
    components: { UiRotaryControl },
    data: () => ({ pre: -18, post: -12, postPan: -9 }),
    methods: {
      db(value: number) {
        return value <= -90 ? "−∞" : `${value.toFixed(1)} dB`
      }
    },
    template: `
      <div style="display:grid;gap:12px;max-width:320px;padding:16px;background:var(--ui-color-canvas)">
        <div style="display:grid;grid-template-columns:24px 1fr;align-items:center;min-height:24px;background:var(--ui-color-surface)">
          <UiRotaryControl size="compact" ring-weight="emphasized" :drag-range-pixels="180" :value="pre" :min="-90" :max="12" :step="0.1" :default-value="-90" label="Pre-fader send level" :value-text="db" accent="var(--ui-color-action)" @preview="pre = $event" @commit="pre = $event" />
          <span style="padding-inline:8px">Vocal reverb</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 24px;align-items:center;min-height:24px;background:var(--ui-color-surface)">
          <span style="padding-inline:8px">Vocal reverb</span>
          <UiRotaryControl size="compact" ring-weight="emphasized" :drag-range-pixels="180" :value="post" :min="-90" :max="12" :step="0.1" :default-value="-90" label="Post-fader send level" :value-text="db" accent="var(--ui-color-action)" @preview="post = $event" @commit="post = $event" />
        </div>
        <div style="display:grid;grid-template-columns:1fr 24px;align-items:center;min-height:24px;background:var(--ui-color-surface)">
          <span style="padding-inline:8px">Vocal reverb</span>
          <UiRotaryControl size="compact" ring-weight="emphasized" :drag-range-pixels="180" :value="postPan" :min="-90" :max="12" :step="0.1" :default-value="-90" label="Post-pan send level" :value-text="db" accent="var(--ui-signal-meter-safe)" @preview="postPan = $event" @commit="postPan = $event" />
        </div>
      </div>
    `
  })
}

export const ChannelFaderAndMeter: Story = {
  render: () => ({
    components: { UiLevelMeter, UiVerticalFader },
    data: () => ({
      gain: 0,
      marks: [
        { value: 12, label: "+12", position: 0 },
        { value: 0, label: "0", position: 11.76, emphasis: true },
        { value: -12, label: "−12", position: 23.53 },
        { value: -30, label: "−30", position: 41.18 },
        { value: -60, label: "−60", position: 70.59 },
        { value: -90, label: "−∞", position: 100 }
      ],
      meterMarks: [
        { value: 0, label: "0", position: 0, emphasis: true },
        { value: -12, label: "−12", position: 20 },
        { value: -24, label: "−24", position: 40 },
        { value: -48, label: "−48", position: 80 },
        { value: -60, label: "−∞", position: 100 }
      ]
    }),
    methods: {
      db(value: number) {
        return value <= -90 ? "−∞" : `${value.toFixed(1)} dB`
      }
    },
    template: `
      <div style="display:grid;grid-template-columns:72px 34px;gap:8px;height:240px;padding:24px;background:var(--ui-color-surface)">
        <UiVerticalFader
          :value="gain"
          :min="-90"
          :max="12"
          :step="0.1"
          :default-value="0"
          :marks="marks"
          label="Vocal volume"
          :value-text="db"
          @preview="gain = $event"
          @commit="gain = $event"
        />
        <UiLevelMeter
          :level-percent="72"
          :held-level-percent="84"
          :has-held-peak="true"
          :clipped="false"
          :marks="meterMarks"
          label="Vocal post-fader level"
        />
      </div>
    `
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const fader = canvas.getByRole("slider", { name: "Vocal volume" })
    await fireEvent.input(fader, { target: { value: "-0.1" } })
    await fireEvent.change(fader, { target: { value: "-0.1" } })
    await expect(fader).toHaveAttribute("aria-valuetext", "-0.1 dB")
    await userEvent.dblClick(fader)
    await expect(fader).toHaveAttribute("aria-valuetext", "0.0 dB")
    await expect(canvas.getByRole("meter", { name: "Vocal post-fader level" })).toHaveAttribute(
      "aria-valuenow",
      "72"
    )
  }
}

export const ChannelStateButtons: Story = {
  render: () => ({
    components: { UiMixerStateButton },
    data: () => ({ mute: false, solo: true, record: false, monitor: true }),
    template: `
      <div style="display:grid;gap:16px;padding:24px;background:var(--ui-color-surface)">
        <div style="display:flex;gap:5px">
          <UiMixerStateButton tone="mute" label="Mute Vocal" :pressed="mute" @click="mute = !mute">M</UiMixerStateButton>
          <UiMixerStateButton tone="solo" label="Solo Vocal" :pressed="solo" @click="solo = !solo">S</UiMixerStateButton>
        </div>
        <div style="display:flex">
          <UiMixerStateButton size="narrow" tone="record" joined="start" label="Arm Vocal" :pressed="record" @click="record = !record">R</UiMixerStateButton>
          <UiMixerStateButton size="narrow" tone="input" joined="end" label="Monitor Vocal" :pressed="monitor" @click="monitor = !monitor">I</UiMixerStateButton>
        </div>
      </div>
    `
  }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const mute = canvas.getByRole("button", { name: "Mute Vocal" })
    await expect(mute).toHaveAttribute("aria-pressed", "false")
    await userEvent.click(mute)
    await expect(mute).toHaveAttribute("aria-pressed", "true")
  }
}

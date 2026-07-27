import type { Meta, StoryObj } from "@storybook/vue3-vite"

import {
  UiButton,
  UiCheckbox,
  UiField,
  UiProgress,
  UiSectionHeading,
  UiSelect,
  UiStatusNotice,
  UiSurface,
  YadawLogo
} from "@yadaw/ui"

const meta = {
  title: "Product examples/Welcome",
  component: UiSurface,
  parameters: {
    layout: "fullscreen"
  }
} satisfies Meta<typeof UiSurface>

export default meta
type Story = StoryObj<typeof meta>

export const Welcome: Story = {
  render: () => ({
    components: { UiButton, UiSectionHeading, UiSurface, YadawLogo },
    data: () => ({
      projects: [
        { name: "Midnight Session", meta: "Modified 12 minutes ago · 48 kHz" },
        { name: "Film Score Sketches", meta: "Modified yesterday · 96 kHz" }
      ]
    }),
    template: `
      <main style="min-height:100vh;padding:clamp(1rem,6vw,5rem);background:var(--ui-color-canvas)">
        <div style="display:grid;max-width:68rem;margin:auto;gap:var(--ui-space-8)">
          <header>
            <YadawLogo style="color:var(--ui-color-action);font-size:1rem" />
            <h1 style="margin:var(--ui-space-2) 0;font-size:clamp(2rem,7vw,4.5rem);line-height:1">Make the session audible.</h1>
            <p style="max-width:38rem;color:var(--ui-color-text-muted);line-height:var(--ui-line-normal)">Create a project or return to a recent session. Audio configuration remains available before opening the studio.</p>
          </header>
          <div style="display:flex;flex-wrap:wrap;gap:var(--ui-space-3)"><UiButton variant="primary" size="lg">Create project</UiButton><UiButton size="lg">Open project</UiButton><UiButton variant="ghost" size="lg">Audio settings</UiButton></div>
          <UiSurface>
            <UiSectionHeading title="Recent projects" description="Projects are stored locally and opened in place." />
            <div style="display:grid;gap:var(--ui-space-2);margin-top:var(--ui-space-5)">
              <button v-for="project in projects" :key="project.name" class="product-recent-button" style="display:grid;gap:.25rem;width:100%;min-height:var(--ui-control-lg);padding:var(--ui-space-3);text-align:left;color:var(--ui-color-text);background:transparent;border:1px solid var(--ui-color-border);border-radius:var(--ui-radius-md)">
                <strong>{{ project.name }}</strong><span style="color:var(--ui-color-text-muted);font-size:var(--ui-font-size-xs)">{{ project.meta }}</span>
              </button>
            </div>
          </UiSurface>
        </div>
      </main>
    `
  })
}

export const Settings: Story = {
  render: () => ({
    components: { UiButton, UiCheckbox, UiField, UiSectionHeading, UiSelect, UiSurface },
    data: () => ({
      driver: "asio",
      device: "studio",
      exclusive: true,
      drivers: [{ label: "ASIO", value: "asio" }],
      devices: [
        { label: "Studio interface", value: "studio" },
        { label: "Built-in output", value: "built-in" }
      ]
    }),
    template: `
      <main style="max-width:58rem;margin:auto">
        <UiSurface padding="lg">
          <UiSectionHeading title="Audio device" description="Changes briefly suspend playback while the engine is reconfigured." />
          <form class="storybook-stack" style="margin-top:var(--ui-space-6)" @submit.prevent>
            <UiField label="Driver"><template #default="{ controlId }"><UiSelect v-model="driver" :id="controlId" :options="drivers" /></template></UiField>
            <UiField label="Output device"><template #default="{ controlId }"><UiSelect v-model="device" :id="controlId" :options="devices" /></template></UiField>
            <UiCheckbox v-model="exclusive" label="Use exclusive device access" description="Prevents other applications from changing the device format." />
            <div style="display:flex;flex-wrap:wrap;justify-content:flex-end;gap:var(--ui-space-3)"><UiButton>Cancel</UiButton><UiButton variant="primary">Apply settings</UiButton></div>
          </form>
        </UiSurface>
      </main>
    `
  })
}

export const MidiImport: Story = {
  render: () => ({
    components: { UiButton, UiCheckbox, UiProgress, UiSectionHeading, UiSurface },
    data: () => ({ tempo: true, markers: true }),
    template: `
      <UiSurface style="max-width:42rem">
        <UiSectionHeading title="Import MIDI" description="Midnight Keys.mid · 4 tracks · 126 bars · 120 BPM" />
        <div class="storybook-stack" style="margin-top:var(--ui-space-5)">
          <UiCheckbox v-model="tempo" label="Import tempo map" />
          <UiCheckbox v-model="markers" label="Import markers" />
          <UiProgress :value="100" label="MIDI file analysis complete" />
          <div style="display:flex;justify-content:flex-end;gap:var(--ui-space-3)"><UiButton>Cancel</UiButton><UiButton variant="primary">Import four tracks</UiButton></div>
        </div>
      </UiSurface>
    `
  })
}

export const Benchmark: Story = {
  render: () => ({
    components: { UiButton, UiProgress, UiSectionHeading, UiStatusNotice, UiSurface },
    template: `
      <UiSurface style="max-width:48rem">
        <UiSectionHeading title="Audio performance benchmark" description="Measures stable DSP load with the current device and buffer." />
        <div class="storybook-stack" style="margin-top:var(--ui-space-5)">
          <UiProgress :value="72" label="Benchmark progress" value-text="Pass 9 of 12" />
          <UiStatusNotice tone="info" title="Running pass 9 of 12">48 kHz · 128 samples · 64 simulated tracks</UiStatusNotice>
          <div style="display:flex;justify-content:flex-end;gap:var(--ui-space-3)"><UiButton>Stop</UiButton><UiButton variant="primary" disabled>Apply recommendation</UiButton></div>
        </div>
      </UiSurface>
    `
  })
}

export const MixerControls: Story = {
  render: () => ({
    components: { UiButton, UiSectionHeading, UiStatusNotice, UiSurface },
    data: () => ({
      channels: [
        { name: "Drums", peak: "-4.2 dB", color: "var(--ui-signal-audio)" },
        { name: "Keys", peak: "-8.7 dB", color: "var(--ui-signal-midi)" },
        { name: "Vocal", peak: "-2.1 dB", color: "var(--ui-signal-record)" }
      ]
    }),
    template: `
      <div class="mixer-example-scroll" style="overflow:auto">
        <div style="display:grid;grid-template-columns:repeat(3,minmax(11rem,1fr));min-width:36rem;gap:var(--ui-space-3)">
          <UiSurface v-for="channel in channels" :key="channel.name" padding="sm">
            <UiSectionHeading :title="channel.name" />
            <div
              :style="{
                height: '10rem',
                margin: 'var(--ui-space-4) 0',
                background: 'linear-gradient(to top, ' + channel.color + ' 0 58%, var(--ui-color-surface-active) 58%)',
                borderRadius: 'var(--ui-radius-sm)',
              }"
            />
            <UiStatusNotice title="Peak">{{ channel.peak }}</UiStatusNotice>
            <div style="display:flex;gap:var(--ui-space-2);margin-top:var(--ui-space-3)"><UiButton size="sm">Mute</UiButton><UiButton size="sm">Solo</UiButton></div>
          </UiSurface>
        </div>
      </div>
    `
  })
}

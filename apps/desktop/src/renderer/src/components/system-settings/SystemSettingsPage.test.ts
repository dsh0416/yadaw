import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import SystemSettingsPage from "./SystemSettingsPage.vue"

const runtime = {
  state: "stopped" as const,
  backend: null,
  inputDeviceId: null,
  outputDeviceId: null,
  sampleRate: null,
  inputSampleRate: null,
  outputSampleRate: null,
  inputChannels: null,
  outputChannels: null,
  requestedBufferSize: null,
  inputBufferSize: null,
  outputBufferSize: null,
  inputLatencyMs: null,
  outputLatencyMs: null,
  engineLatencyMs: null,
  estimatedRoundTripLatencyMs: null,
  ringBufferLatencyMs: null,
  ringBufferFillFrames: null,
  ringBufferCapacityFrames: null,
  clockSync: "inactive" as const,
  bufferFallback: false,
  xruns: 0
}

function mountPage() {
  return mount(SystemSettingsPage, {
    props: {
      modelValue: {
        backend: "wasapi",
        inputDeviceId: "input",
        outputDeviceId: "output",
        bufferSize: 256
      },
      runtime,
      applyError: "",
      applying: false,
      audioHostRuntime: {
        workerThreads: "auto",
        maxBlockingThreads: "auto",
        egressConcurrency: "auto"
      },
      resolvedAudioHostRuntime: null,
      audioHostRuntimeApplying: false,
      audioHostRuntimeError: "",
      midiPreferences: {
        enabled: false,
        sourcePortId: null,
        sourcePortName: null,
        inputOffsetsMs: {}
      },
      midiSnapshot: {
        ports: [],
        sync: {
          state: "internal",
          sourcePortId: null,
          sourcePortName: null,
          effectiveBpm: null,
          jitterMicroseconds: null,
          lastClockAgeMs: null,
          droppedEvents: 0,
          ignoredSystemMessages: 0,
          error: null
        },
        capturedAt: 0
      },
      midiApplying: false,
      midiError: "",
      backLabel: "Back to studio"
    },
    global: {
      stubs: {
        AudioDeviceSettings: {
          props: ["modelValue"],
          emits: ["update:modelValue", "validityChange"],
          template:
            '<section><h2>Devices</h2><button aria-label="Mark devices ready" @click="$emit(\'validityChange\', true)">Ready</button></section>'
        },
        AudioRuntimeSettings: {
          template: "<section><h2>Runtime scheduling</h2></section>"
        },
        RecordingSettings: true,
        MidiInputSettings: true,
        DisplaySettings: true,
        MixerDisplaySettings: true
      }
    }
  })
}

describe("SystemSettingsPage", () => {
  it("applies a valid audio draft and exposes the two-level system navigation", async () => {
    const wrapper = mountPage()

    expect(wrapper.get("h1").text()).toBe("System settings")
    expect(wrapper.get('nav[aria-label="System settings categories"]').text()).toContain("Audio")
    await wrapper.get('button[aria-label="Mark devices ready"]').trigger("click")
    await wrapper.get("button.settings-action-primary").trigger("click")

    expect(wrapper.emitted("applyAudio")?.[0]?.[0]).toMatchObject({
      backend: "wasapi",
      bufferSize: 256
    })
  })

  it("switches to the engine page and closes from the shared header", async () => {
    const wrapper = mountPage()
    const systemCategory = wrapper
      .get('nav[aria-label="System settings categories"]')
      .findAll("button")
      .find((button) => button.text().includes("System"))

    await systemCategory!.trigger("click")
    expect(wrapper.get("h2").text()).toBe("Runtime scheduling")
    await wrapper.get('button[aria-label="Back to studio"]').trigger("click")
    expect(wrapper.emitted("close")).toHaveLength(1)
  })
})

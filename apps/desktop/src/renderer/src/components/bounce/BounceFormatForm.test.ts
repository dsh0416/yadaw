import { mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"
import type { BounceFormatSettings } from "@heron/contracts"
import BounceFormatForm from "./BounceFormatForm.vue"

vi.mock("@heron/ui", () => ({
  UiSelect: {
    props: ["modelValue", "options", "disabled"],
    emits: ["update:modelValue"],
    template: `
      <select
        :value="modelValue"
        :disabled="disabled"
        @change="$emit('update:modelValue', $event.target.value)"
      >
        <option
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          :disabled="option.disabled"
        >{{ option.label }}</option>
      </select>
    `
  },
  UiNumberInput: {
    props: ["modelValue", "min", "max"],
    emits: ["update:modelValue"],
    template: `
      <input
        type="number"
        :value="modelValue"
        :min="min"
        :max="max"
        @input="$emit('update:modelValue', Number($event.target.value))"
      />
    `
  }
}))

function mountForm(settings: BounceFormatSettings, projectSampleRate = 96_000) {
  return mount(BounceFormatForm, {
    props: { settings, sampleRate: "project", projectSampleRate }
  })
}

function control(wrapper: ReturnType<typeof mountForm>, label: string, selector: string) {
  const field = wrapper
    .findAll("label")
    .find((candidate) => candidate.find("span").text() === label)
  if (!field) throw new Error(`missing ${label} field`)
  return field.get(selector)
}

describe("BounceFormatForm", () => {
  it("emits safe defaults when the user switches file formats", async () => {
    const wrapper = mountForm({ format: "wav", bitDepth: "pcm24", dither: "tpdf" })
    const format = control(wrapper, "File format", "select")

    await format.setValue("flac")
    await format.setValue("mp3")
    await format.setValue("wav")
    await control(wrapper, "Sample rate", "select").setValue("48000")

    expect(wrapper.emitted("updateSettings")).toEqual([
      [{ format: "flac", bitDepth: "pcm24", compressionLevel: 5, dither: "tpdf" }],
      [{ format: "mp3", bitrate: { mode: "cbr", kbps: 320 } }],
      [{ format: "wav", bitDepth: "pcm24", dither: "tpdf" }]
    ])
    expect(wrapper.emitted("updateSampleRate")).toEqual([[48_000]])
  })

  it("updates PCM depth, dither, and FLAC compression", async () => {
    const wav = mountForm({ format: "wav", bitDepth: "pcm24", dither: "tpdf" })
    await control(wav, "Encoding", "select").setValue("float32")
    await control(wav, "Dither", "select").setValue("off")
    expect(wav.emitted("updateSettings")).toEqual([
      [{ format: "wav", bitDepth: "float32", dither: "off" }],
      [{ format: "wav", bitDepth: "pcm24", dither: "off" }]
    ])

    const flac = mountForm({
      format: "flac",
      bitDepth: "pcm24",
      compressionLevel: 5,
      dither: "tpdf"
    })
    await control(flac, "Encoding", "select").setValue("pcm16")
    await control(flac, "Dither", "select").setValue("off")
    await control(flac, "Compression", 'input[type="number"]').setValue("8")
    expect(flac.emitted("updateSettings")).toEqual([
      [{ format: "flac", bitDepth: "pcm16", compressionLevel: 5, dither: "tpdf" }],
      [{ format: "flac", bitDepth: "pcm24", compressionLevel: 5, dither: "off" }],
      [{ format: "flac", bitDepth: "pcm24", compressionLevel: 8, dither: "tpdf" }]
    ])
  })

  it("limits MP3 sample rates and configures both bitrate modes", async () => {
    const cbr = mountForm({ format: "mp3", bitrate: { mode: "cbr", kbps: 320 } })
    const sampleRateOptions = control(cbr, "Sample rate", "select").findAll("option")
    expect(sampleRateOptions.map((option) => option.attributes("disabled") !== undefined)).toEqual([
      true,
      false,
      false,
      true,
      true
    ])
    await control(cbr, "Bitrate mode", "select").setValue("vbr")
    await control(cbr, "Bitrate", "select").setValue("192")
    expect(cbr.emitted("updateSettings")).toEqual([
      [{ format: "mp3", bitrate: { mode: "vbr", quality: 2 } }],
      [{ format: "mp3", bitrate: { mode: "cbr", kbps: 192 } }]
    ])

    const vbr = mountForm({ format: "mp3", bitrate: { mode: "vbr", quality: 2 } }, 48_000)
    await control(vbr, "VBR quality", 'input[type="number"]').setValue("7")
    await control(vbr, "Bitrate mode", "select").setValue("cbr")
    expect(vbr.emitted("updateSettings")).toEqual([
      [{ format: "mp3", bitrate: { mode: "vbr", quality: 7 } }],
      [{ format: "mp3", bitrate: { mode: "cbr", kbps: 320 } }]
    ])
  })
})

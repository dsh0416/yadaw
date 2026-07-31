import { createPinia, setActivePinia } from "pinia"
import { flushPromises, mount } from "@vue/test-utils"
import { defineComponent, ref, type Ref } from "vue"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { INITIAL_AUDIO_RUNTIME_SNAPSHOT } from "@yadaw/contracts"
import type {
  AudioBackendDescriptor,
  AudioDeviceDescriptor,
  AudioDeviceList,
  AudioPreferences,
  AudioRuntimeSnapshot
} from "@yadaw/contracts"
import { rpcFailure, rpcSuccess, testBootstrap } from "../../test/ipc"
import { useAudioRuntimeStore } from "../../stores/audioRuntime"
import { useAudioDeviceOptions } from "./useAudioDeviceOptions"

type DeviceOptions = ReturnType<typeof useAudioDeviceOptions>

function device(id: string, overrides: Partial<AudioDeviceDescriptor> = {}): AudioDeviceDescriptor {
  return {
    id,
    name: id.toUpperCase(),
    isDefault: false,
    defaultSampleRate: 48_000,
    minBufferSize: 32,
    maxBufferSize: 2_048,
    channelCount: 2,
    ...overrides
  }
}

function stubApi(overrides: Record<string, unknown>): void {
  Object.assign(window.yadaw as unknown as Record<string, unknown>, overrides)
}

interface Harness {
  options: DeviceOptions
  preferences: Ref<AudioPreferences>
  validity: boolean[]
}

async function mountOptions(
  initial: Partial<AudioPreferences> = {},
  runtime: AudioRuntimeSnapshot = INITIAL_AUDIO_RUNTIME_SNAPSHOT
): Promise<Harness> {
  const preferences = ref<AudioPreferences>({
    backend: "alsa",
    inputDeviceId: "",
    outputDeviceId: "",
    bufferSize: 256,
    ...initial
  })
  const validity: boolean[] = []
  let options!: DeviceOptions

  mount(
    defineComponent({
      setup() {
        options = useAudioDeviceOptions(
          preferences,
          () => runtime,
          (valid) => validity.push(valid)
        )
        return () => null
      }
    })
  )
  await flushPromises()

  return { options, preferences, validity }
}

const backends: AudioBackendDescriptor[] = [
  { id: "alsa", label: "ALSA", available: true },
  { id: "asio", label: "ASIO", available: false },
  { id: "wasapi", label: "WASAPI", available: false },
  { id: "coreaudio", label: "CoreAudio", available: false }
]

const devices: AudioDeviceList = {
  inputs: [device("in-1"), device("in-default", { isDefault: true })],
  outputs: [device("out-default", { isDefault: true }), device("out-2")]
}

beforeEach(() => {
  setActivePinia(createPinia())
  useAudioRuntimeStore().applyResources(testBootstrap().audioResources)
  stubApi({
    listAudioBackends: vi.fn(async () => rpcSuccess(backends)),
    listAudioDevices: vi.fn(async () => rpcSuccess(devices))
  })
})

describe("backend options", () => {
  it("offers only the backends the host reports as available", async () => {
    const { options } = await mountOptions()

    expect(options.availableBackendOptions.value).toEqual(["alsa"])
    expect(options.backendUiOptions.value).toHaveLength(1)
    expect(options.backendUiOptions.value[0]?.value).toBe("alsa")
  })

  it("labels each backend with its platform and description", async () => {
    const { options } = await mountOptions()

    const [option] = options.backendUiOptions.value
    expect(option?.label).toContain("·")
    expect(option?.label.length).toBeGreaterThan(1)
    expect(option?.description).toBeTruthy()
  })

  it("switches to the first available backend when the saved one is gone", async () => {
    const { preferences } = await mountOptions({ backend: "asio" })

    expect(preferences.value.backend).toBe("alsa")
  })

  it("marks discovery unavailable when no host reports itself as usable", async () => {
    stubApi({
      listAudioBackends: vi.fn(async () =>
        rpcSuccess(backends.map((entry) => ({ ...entry, available: false })))
      )
    })

    const { options } = await mountOptions()

    expect(options.discoveryState.value).toBe("unavailable")
    expect(options.discoveryError.value).toBeTruthy()
  })

  it("writes the chosen backend back through the selection model", async () => {
    const { options, preferences } = await mountOptions()

    options.backendSelection.value = "asio"

    expect(preferences.value.backend).toBe("asio")
    expect(options.backendSelection.value).toBe("asio")
  })

  it("clears the device selection when the chosen backend is unavailable", async () => {
    const { options, preferences } = await mountOptions()

    options.backendSelection.value = "asio"
    await flushPromises()

    expect(preferences.value.inputDeviceId).toBe("")
    expect(preferences.value.outputDeviceId).toBe("")
    expect(options.discoveryState.value).toBe("unavailable")
  })
})

describe("device options", () => {
  it("adopts the default input and output on first load", async () => {
    const { preferences } = await mountOptions()

    expect(preferences.value.inputDeviceId).toBe("in-default")
    expect(preferences.value.outputDeviceId).toBe("out-default")
  })

  it("keeps a saved device that is still present", async () => {
    const { preferences } = await mountOptions({
      inputDeviceId: "in-1",
      outputDeviceId: "out-2"
    })

    expect(preferences.value.inputDeviceId).toBe("in-1")
    expect(preferences.value.outputDeviceId).toBe("out-2")
  })

  it("marks the default device in the option label", async () => {
    const { options } = await mountOptions()

    expect(options.inputDeviceOptions.value.map((option) => option.value)).toEqual([
      "in-1",
      "in-default"
    ])
    expect(options.inputDeviceOptions.value[0]?.label).toBe("IN-1")
    expect(options.inputDeviceOptions.value[1]?.label).toContain("·")
    expect(options.outputDeviceOptions.value[0]?.label).toContain("·")
  })

  it("exposes the descriptors behind the current selection", async () => {
    const { options } = await mountOptions()

    expect(options.selectedInputDevice.value?.id).toBe("in-default")
    expect(options.selectedOutputDevice.value?.id).toBe("out-default")
  })

  it("writes device choices back through the models", async () => {
    const { options, preferences } = await mountOptions()

    options.inputDeviceModel.value = "in-1"
    options.outputDeviceModel.value = "out-2"

    expect(preferences.value).toMatchObject({ inputDeviceId: "in-1", outputDeviceId: "out-2" })
  })

  it("falls back to the first device when none is marked default", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () =>
        rpcSuccess({
          inputs: [device("in-a"), device("in-b")],
          outputs: [device("out-a")]
        })
      )
    })

    const { preferences } = await mountOptions()

    expect(preferences.value.inputDeviceId).toBe("in-a")
  })

  it("clears the selection when enumeration fails", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () => rpcFailure("errors.audioEngineUnavailable"))
    })

    const { preferences, options } = await mountOptions({
      inputDeviceId: "in-1",
      outputDeviceId: "out-2"
    })

    expect(preferences.value.inputDeviceId).toBe("")
    expect(preferences.value.outputDeviceId).toBe("")
    expect(options.discoveryState.value).toBe("unavailable")
  })

  it("re-enumerates devices when the backend changes", async () => {
    const listAudioDevices = vi.fn(async () => rpcSuccess(devices))
    stubApi({
      listAudioBackends: vi.fn(async () =>
        rpcSuccess(
          backends.map((entry) => (entry.id === "asio" ? { ...entry, available: true } : entry))
        )
      ),
      listAudioDevices
    })
    const { options } = await mountOptions()
    listAudioDevices.mockClear()

    options.backendSelection.value = "asio"
    await flushPromises()

    expect(listAudioDevices).toHaveBeenCalledWith(expect.any(Object), "asio")
  })

  it("re-enumerates on demand through refreshDevices", async () => {
    const listAudioDevices = vi.fn(async () => rpcSuccess(devices))
    stubApi({ listAudioDevices })
    const { options } = await mountOptions()
    listAudioDevices.mockClear()

    await options.refreshDevices()

    expect(listAudioDevices).toHaveBeenCalledWith(expect.any(Object), "alsa")
  })
})

describe("buffer size options", () => {
  it("restricts the list to the range both devices support", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () =>
        rpcSuccess({
          inputs: [device("in-1", { isDefault: true, minBufferSize: 64, maxBufferSize: 512 })],
          outputs: [device("out-1", { isDefault: true, minBufferSize: 128, maxBufferSize: 1_024 })]
        })
      )
    })

    const { options } = await mountOptions()

    expect(options.bufferSizeOptions.value.map((option) => Number(option.value))).toEqual([
      128, 256, 512
    ])
  })

  it("includes device-reported sizes that are not on the standard list", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () =>
        rpcSuccess({
          inputs: [device("in-1", { isDefault: true, minBufferSize: 96, maxBufferSize: 384 })],
          outputs: [device("out-1", { isDefault: true, minBufferSize: 96, maxBufferSize: 384 })]
        })
      )
    })

    const { options } = await mountOptions()

    expect(options.bufferSizeOptions.value.map((option) => Number(option.value))).toEqual([
      96, 128, 256, 384
    ])
  })

  it("moves an unsupported saved buffer size to the smallest supported one", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () =>
        rpcSuccess({
          inputs: [device("in-1", { isDefault: true, minBufferSize: 512, maxBufferSize: 2_048 })],
          outputs: [device("out-1", { isDefault: true, minBufferSize: 512, maxBufferSize: 2_048 })]
        })
      )
    })

    const { preferences } = await mountOptions({ bufferSize: 64 })

    expect(preferences.value.bufferSize).toBe(512)
  })

  it("keeps a supported saved buffer size", async () => {
    const { preferences } = await mountOptions({ bufferSize: 512 })

    expect(preferences.value.bufferSize).toBe(512)
  })

  it("accepts a supported size through the model and ignores anything else", async () => {
    const { options, preferences } = await mountOptions()

    options.bufferSizeModel.value = "512"
    expect(preferences.value.bufferSize).toBe(512)
    expect(options.bufferSizeModel.value).toBe("512")

    options.bufferSizeModel.value = "7"
    expect(preferences.value.bufferSize).toBe(512)
  })

  it("falls back to the widest range when devices report no limits", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () =>
        rpcSuccess({
          inputs: [device("in-1", { isDefault: true, minBufferSize: null, maxBufferSize: null })],
          outputs: [device("out-1", { isDefault: true, minBufferSize: null, maxBufferSize: null })]
        })
      )
    })

    const { options } = await mountOptions()

    expect(options.bufferSizeOptions.value.map((option) => Number(option.value))).toEqual([
      32, 64, 128, 256, 512, 1_024, 2_048
    ])
  })

  it("offers the reported, running, and current sizes when device ranges do not overlap", async () => {
    stubApi({
      listAudioDevices: vi.fn(async () =>
        rpcSuccess({
          inputs: [device("in-1", { isDefault: true, minBufferSize: 1_024, maxBufferSize: 2_048 })],
          outputs: [device("out-1", { isDefault: true, minBufferSize: 32, maxBufferSize: 64 })]
        })
      )
    })

    const { options } = await mountOptions(
      { bufferSize: 256 },
      { ...INITIAL_AUDIO_RUNTIME_SNAPSHOT, inputBufferSize: 480, outputBufferSize: 480 }
    )

    expect(options.bufferSizeOptions.value.map((option) => Number(option.value))).toEqual([
      32, 64, 256, 480, 1_024, 2_048
    ])
  })
})

describe("apply validity", () => {
  it("reports invalid before devices resolve and valid once they do", async () => {
    const { validity } = await mountOptions()

    expect(validity[0]).toBe(false)
    expect(validity.at(-1)).toBe(true)
  })

  it("reports invalid again when the backend becomes unusable", async () => {
    const { options, validity } = await mountOptions()
    expect(validity.at(-1)).toBe(true)

    options.backendSelection.value = "asio"
    await flushPromises()

    expect(validity.at(-1)).toBe(false)
  })
})

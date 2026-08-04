import type { IpcMainInvokeEvent } from "electron"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AUDIO_BACKENDS } from "@heron/contracts"
import type { CreateProjectRequest } from "@heron/contracts"
import type { ApplicationSettingsStore } from "../settings"
import type { AudioHostService } from "../audio-host"
import {
  assertTrustedSender,
  sampleSystemPerformance,
  validateApplicationWindowCommand,
  validateAudioBackend,
  validateAudioPreferences,
  validateCreateProject,
  validateGainRequest,
  validateProjectConfiguration,
  validateRoundTripLatencyMeasurementRequest,
  validateSettingsPatch,
  validateWaveformRequest
} from "./support"

const electron = vi.hoisted(() => ({ isPackaged: true }))

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => ""),
    get isPackaged() {
      return electron.isPackaged
    }
  }
}))

function eventFrom(url: string, mainFrameUrl = url): IpcMainInvokeEvent {
  const senderFrame = { url }
  const mainFrame = mainFrameUrl === url ? senderFrame : { url: mainFrameUrl }
  return { senderFrame, sender: { mainFrame } } as unknown as IpcMainInvokeEvent
}

describe("assertTrustedSender", () => {
  beforeEach(() => {
    electron.isPackaged = true
    vi.stubEnv("HERON_RENDERER_URL", undefined)
  })

  it("accepts only the packaged custom-protocol main entry", () => {
    expect(() => assertTrustedSender(eventFrom("heron-app://bundle/index.html"))).not.toThrow()
    expect(() => assertTrustedSender(eventFrom("heron-app://bundle/splash.html"))).toThrow(
      "Rejected IPC call from an untrusted renderer"
    )
  })

  it("rejects a forged custom-protocol host and wrong entry", () => {
    expect(() => assertTrustedSender(eventFrom("heron-app://bundle.evil/index.html"))).toThrow(
      "Rejected IPC call from an untrusted renderer"
    )
    expect(() => assertTrustedSender(eventFrom("heron-app://bundle/other.html"))).toThrow()
  })

  it("rejects a call that arrives without a sender frame", () => {
    expect(() => assertTrustedSender({} as IpcMainInvokeEvent)).toThrow(
      "Rejected IPC call without a sender frame"
    )
  })

  it("accepts only the fixed Vite main entry in development", () => {
    electron.isPackaged = false
    vi.stubEnv("HERON_RENDERER_URL", "http://127.0.0.1:5173/")

    expect(() => assertTrustedSender(eventFrom("http://127.0.0.1:5173/"))).not.toThrow()
    expect(() => assertTrustedSender(eventFrom("http://127.0.0.1:5173/splash.html"))).toThrow(
      "Rejected IPC call from an untrusted renderer"
    )
  })

  it("rejects remote origins even when a dev server is configured", () => {
    electron.isPackaged = false
    vi.stubEnv("HERON_RENDERER_URL", "http://127.0.0.1:5173/")

    expect(() => assertTrustedSender(eventFrom("https://example.com/index.html"))).toThrow(
      "Rejected IPC call from an untrusted renderer"
    )
  })

  it("rejects subframes even when their URL is trusted", () => {
    expect(() =>
      assertTrustedSender(
        eventFrom("heron-app://bundle/index.html", "heron-app://bundle/splash.html")
      )
    ).toThrow("Rejected IPC call from a subframe")
  })
})

describe("validateCreateProject", () => {
  const request: CreateProjectRequest = {
    name: "Demo",
    sampleRate: 48_000,
    timeSignatureNumerator: 4,
    timeSignatureDenominator: 4,
    waveformDisplayMode: "separate"
  }

  it("accepts a complete request, with or without a path", () => {
    expect(validateCreateProject(request)).toBe(request)
    expect(validateCreateProject({ ...request, path: "/projects/demo.heron" })).toMatchObject({
      path: "/projects/demo.heron"
    })
  })

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "demo", 42, true]) {
      expect(() => validateCreateProject(value)).toThrow(TypeError)
    }
  })

  it("rejects a request with a missing or mistyped field", () => {
    const invalid: Record<string, unknown>[] = [
      { ...request, name: 42 },
      { ...request, sampleRate: "48000" },
      { ...request, timeSignatureNumerator: null },
      { ...request, timeSignatureDenominator: undefined },
      { ...request, waveformDisplayMode: "stacked" },
      { ...request, path: 7 }
    ]

    for (const value of invalid) {
      expect(() => validateCreateProject(value), JSON.stringify(value)).toThrow(
        "Invalid project options"
      )
    }
  })

  it("strips the path when narrowing a request to a project configuration", () => {
    const configuration = validateProjectConfiguration({ ...request, path: "/projects/demo.heron" })

    expect(configuration).toEqual(request)
    expect(configuration).not.toHaveProperty("path")
  })
})

describe("validateWaveformRequest", () => {
  const request = { id: "asset-1", startFrame: 0, endFrame: 4_800, maxBuckets: 512 }

  it("accepts a well-formed window", () => {
    expect(validateWaveformRequest(request)).toBe(request)
  })

  it("accepts an empty window at the same frame", () => {
    expect(() =>
      validateWaveformRequest({ ...request, startFrame: 10, endFrame: 10 })
    ).not.toThrow()
  })

  it("rejects non-objects", () => {
    expect(() => validateWaveformRequest(null)).toThrow("Waveform request must be an object")
  })

  it("rejects ids that are empty or absurdly long", () => {
    expect(() => validateWaveformRequest({ ...request, id: "" })).toThrow(
      "Invalid waveform request"
    )
    expect(() => validateWaveformRequest({ ...request, id: "a".repeat(257) })).toThrow(
      "Invalid waveform request"
    )
  })

  it("rejects negative, reversed, or non-integer frame ranges", () => {
    const invalid = [
      { ...request, startFrame: -1 },
      { ...request, startFrame: 1.5 },
      { ...request, endFrame: -1 },
      { ...request, startFrame: 100, endFrame: 50 }
    ]

    for (const value of invalid) {
      expect(() => validateWaveformRequest(value), JSON.stringify(value)).toThrow(
        "Invalid waveform request"
      )
    }
  })

  it("bounds the bucket count so a renderer cannot request unbounded work", () => {
    expect(() => validateWaveformRequest({ ...request, maxBuckets: 0 })).toThrow(
      "Invalid waveform request"
    )
    expect(() => validateWaveformRequest({ ...request, maxBuckets: 4_097 })).toThrow(
      "Invalid waveform request"
    )
    expect(() => validateWaveformRequest({ ...request, maxBuckets: 4_096 })).not.toThrow()
  })
})

describe("validateSettingsPatch", () => {
  it("accepts an empty patch", () => {
    expect(validateSettingsPatch({})).toEqual({})
  })

  it("accepts every supported enumerated value", () => {
    expect(() =>
      validateSettingsPatch({
        swapDirectory: "/swap",
        recordingBitDepth: "pcm16",
        theme: "dark",
        locale: "en-US",
        meterPeakHold: "infinite",
        meterReturnRate: "iec-type-i",
        midiCenterCStandard: "roland-c4"
      })
    ).not.toThrow()
  })

  it("rejects non-objects", () => {
    expect(() => validateSettingsPatch(null)).toThrow("Settings patch must be an object")
  })

  it("rejects each unsupported value with a field-specific message", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ swapDirectory: 7 }, "Swap directory must be a string"],
      [{ recordingBitDepth: "pcm32" }, "Unsupported recording bit depth"],
      [{ theme: "sepia" }, "Unsupported theme preference"],
      [{ locale: "fr-FR" }, "Unsupported locale preference"],
      [{ meterPeakHold: "10s" }, "Unsupported meter peak hold"],
      [{ meterReturnRate: "iec-type-ii" }, "Unsupported meter return rate"],
      [{ midiCenterCStandard: "middle-c" }, "Unsupported MIDI center C standard"]
    ]

    for (const [patch, message] of cases) {
      expect(() => validateSettingsPatch(patch), message).toThrow(message)
    }
  })
})

describe("validateGainRequest", () => {
  it("accepts a finite sample array within the gain range", () => {
    expect(validateGainRequest({ samples: [-1, 0, 1], gain: -16 })).toEqual({
      samples: [-1, 0, 1],
      gain: -16
    })
  })

  it("rejects non-objects", () => {
    expect(() => validateGainRequest(null)).toThrow("Gain request must be an object")
  })

  it("rejects sample arrays that are the wrong shape, too long, or non-finite", () => {
    expect(() => validateGainRequest({ samples: "0,1", gain: 1 })).toThrow(/Samples must be/)
    expect(() => validateGainRequest({ samples: [Number.NaN], gain: 1 })).toThrow(/Samples must be/)
    expect(() => validateGainRequest({ samples: [Number.POSITIVE_INFINITY], gain: 1 })).toThrow(
      /Samples must be/
    )
    expect(() => validateGainRequest({ samples: new Array(1_000_001).fill(0), gain: 1 })).toThrow(
      /Samples must be/
    )
  })

  it("bounds the gain to the range the preview stage supports", () => {
    expect(() => validateGainRequest({ samples: [], gain: 16.5 })).toThrow(/Gain must be/)
    expect(() => validateGainRequest({ samples: [], gain: Number.NaN })).toThrow(/Gain must be/)
    expect(() => validateGainRequest({ samples: [], gain: "1" })).toThrow(/Gain must be/)
  })
})

describe("validateAudioBackend", () => {
  it("accepts every shipped cpal host, including the mock backend", () => {
    for (const backend of AUDIO_BACKENDS) {
      expect(validateAudioBackend(backend)).toBe(backend)
    }
  })

  it("rejects unknown backends", () => {
    expect(() => validateAudioBackend("jack")).toThrow("Unknown audio backend")
    expect(() => validateAudioBackend(1)).toThrow("Unknown audio backend")
    expect(() => validateAudioBackend(null)).toThrow("Unknown audio backend")
  })
})

describe("validateAudioPreferences", () => {
  const preferences = {
    backend: "alsa",
    inputDeviceId: "in-1",
    outputDeviceId: "out-1",
    bufferSize: 256
  }

  it("returns only the known preference fields", () => {
    expect(validateAudioPreferences({ ...preferences, extra: true })).toEqual(preferences)
  })

  it("rejects non-objects", () => {
    expect(() => validateAudioPreferences(null)).toThrow("Audio preferences must be an object")
  })

  it("requires both devices to be named", () => {
    expect(() => validateAudioPreferences({ ...preferences, inputDeviceId: "" })).toThrow(
      "An input device is required"
    )
    expect(() => validateAudioPreferences({ ...preferences, outputDeviceId: 5 })).toThrow(
      "An output device is required"
    )
  })

  it("bounds the buffer size to what the engine can allocate", () => {
    for (const bufferSize of [8, 16_385, 256.5, "256"]) {
      expect(
        () => validateAudioPreferences({ ...preferences, bufferSize }),
        String(bufferSize)
      ).toThrow("Unsupported audio buffer size")
    }
    expect(() => validateAudioPreferences({ ...preferences, bufferSize: 16 })).not.toThrow()
  })
})

describe("validateApplicationWindowCommand", () => {
  it("accepts a command the window menu can dispatch", () => {
    expect(validateApplicationWindowCommand("window.minimize")).toBe("window.minimize")
  })

  it("rejects anything else", () => {
    expect(() => validateApplicationWindowCommand("window.explode")).toThrow(
      "Unknown application window command"
    )
    expect(() => validateApplicationWindowCommand(null)).toThrow(
      "Unknown application window command"
    )
  })
})

describe("validateRoundTripLatencyMeasurementRequest", () => {
  it("accepts one-based channels inside the supported range", () => {
    expect(
      validateRoundTripLatencyMeasurementRequest({ inputChannel: 1, outputChannel: 256 })
    ).toEqual({ inputChannel: 1, outputChannel: 256 })
  })

  it("rejects non-objects", () => {
    expect(() => validateRoundTripLatencyMeasurementRequest(null)).toThrow(
      "Round-trip latency measurement request must be an object"
    )
  })

  it("names the offending channel when it is out of range", () => {
    expect(() =>
      validateRoundTripLatencyMeasurementRequest({ inputChannel: 0, outputChannel: 1 })
    ).toThrow("Round-trip latency input channel must be between 1 and 256")
    expect(() =>
      validateRoundTripLatencyMeasurementRequest({ inputChannel: 1, outputChannel: 257 })
    ).toThrow("Round-trip latency output channel must be between 1 and 256")
    expect(() =>
      validateRoundTripLatencyMeasurementRequest({ inputChannel: 1.5, outputChannel: 1 })
    ).toThrow("Round-trip latency input channel must be between 1 and 256")
  })
})

describe("sampleSystemPerformance", () => {
  const settings = {
    get: async () => ({ swapDirectory: "" })
  } as unknown as ApplicationSettingsStore

  function service(diagnostics: unknown): AudioHostService {
    return { performanceDiagnostics: () => diagnostics } as unknown as AudioHostService
  }

  it("reports memory usage as a percentage of installed memory", async () => {
    const snapshot = await sampleSystemPerformance(settings, service(null))

    expect(snapshot.memory.usedBytes + snapshot.memory.freeBytes).toBe(snapshot.memory.totalBytes)
    expect(snapshot.memory.usagePercent).toBeGreaterThanOrEqual(0)
    expect(snapshot.memory.usagePercent).toBeLessThanOrEqual(100)
  })

  it("reports one entry per core and no overall usage until a second sample", async () => {
    const first = await sampleSystemPerformance(settings, service(null))
    expect(first.cpu.cores.length).toBeGreaterThan(0)
    expect(first.cpu.cores.map((core) => core.index)).toEqual(
      first.cpu.cores.map((_, index) => index)
    )

    const second = await sampleSystemPerformance(settings, service(null))
    for (const core of second.cpu.cores) {
      if (core.usagePercent === null) continue
      expect(core.usagePercent).toBeGreaterThanOrEqual(0)
      expect(core.usagePercent).toBeLessThanOrEqual(100)
    }
  })

  it("marks an unconfigured swap directory rather than probing the filesystem", async () => {
    const snapshot = await sampleSystemPerformance(settings, service(null))

    const swap = snapshot.storage.find((entry) => entry.id === "swap")
    expect(swap).toMatchObject({ state: "unconfigured", path: null, freeBytes: null })
  })

  it("marks a swap directory that cannot be stat'd as unavailable", async () => {
    const configured = {
      get: async () => ({ swapDirectory: "/definitely/not/a/real/path" })
    } as unknown as ApplicationSettingsStore

    const snapshot = await sampleSystemPerformance(configured, service(null))

    expect(snapshot.storage.find((entry) => entry.id === "swap")).toMatchObject({
      state: "unavailable",
      path: "/definitely/not/a/real/path"
    })
  })

  it("passes the audio host diagnostics straight through", async () => {
    const diagnostics = { runtime: { resolved: null } }

    const snapshot = await sampleSystemPerformance(settings, service(diagnostics))

    expect(snapshot.audioRuntime).toBe(diagnostics)
  })
})

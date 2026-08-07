import { describe, expect, it, vi } from "vitest"

const registrations = vi.hoisted(() => ({
  audio: vi.fn(),
  bounce: vi.fn(),
  diagnostic: vi.fn(),
  midi: vi.fn(),
  lowLatency: vi.fn(),
  mixer: vi.fn(),
  plugin: vi.fn(),
  project: vi.fn(),
  recording: vi.fn(),
  settings: vi.fn(),
  system: vi.fn(),
  transport: vi.fn(),
  dispose: vi.fn(),
  publishers: vi.fn(),
  synchronize: vi.fn(async () => undefined),
  performance: vi.fn(() => ({ capturedAt: 1 }))
}))

vi.mock("./audio-handlers", () => ({ registerAudioHandlers: registrations.audio }))
vi.mock("./bounce-handlers", () => ({ registerBounceHandlers: registrations.bounce }))
vi.mock("./diagnostic-handlers", () => ({ registerDiagnosticHandlers: registrations.diagnostic }))
vi.mock("./midi-handlers", () => ({ registerMidiHandlers: registrations.midi }))
vi.mock("./low-latency-handlers", () => ({ registerLowLatencyHandlers: registrations.lowLatency }))
vi.mock("./mixer-handlers", () => ({ registerMixerHandlers: registrations.mixer }))
vi.mock("./plugin-handlers", () => ({ registerPluginHandlers: registrations.plugin }))
vi.mock("./project-handlers", () => ({ registerProjectHandlers: registrations.project }))
vi.mock("./recording-handlers", () => ({ registerRecordingHandlers: registrations.recording }))
vi.mock("./settings-rpc-handlers", () => ({ registerSettingsRpcHandlers: registrations.settings }))
vi.mock("./system-handlers", () => ({ registerSystemHandlers: registrations.system }))
vi.mock("./transport-handlers", () => ({ registerTransportHandlers: registrations.transport }))
vi.mock("./support", () => ({ sampleSystemPerformance: registrations.performance }))
vi.mock("./event-publishers", () => ({
  registerIpcEventPublishers: registrations.publishers.mockImplementation(() => ({
    dispose: registrations.dispose
  }))
}))
vi.mock("../project", () => ({
  ProjectLifecycleService: class {},
  synchronizePluginStatesAtomically: registrations.synchronize
}))

import { registerIpcHandlers } from "./register"

function services() {
  return {
    audioHost: {},
    projectGraph: {},
    settings: {},
    projects: {},
    lifecycle: {},
    operations: {},
    waveforms: {}
  }
}

describe("registerIpcHandlers", () => {
  it("builds one shared context and installs every handler group", async () => {
    const registration = registerIpcHandlers(services() as never)
    for (const register of [
      registrations.audio,
      registrations.bounce,
      registrations.diagnostic,
      registrations.midi,
      registrations.lowLatency,
      registrations.mixer,
      registrations.plugin,
      registrations.project,
      registrations.recording,
      registrations.settings,
      registrations.system,
      registrations.transport
    ]) {
      expect(register).toHaveBeenCalledOnce()
      expect(register.mock.calls[0]![0]).toBe(registrations.audio.mock.calls[0]![0])
    }
    const context = registrations.audio.mock.calls[0]![0]
    await context.synchronizePluginStates()
    context.sampleSystemPerformance()
    expect(registrations.synchronize).toHaveBeenCalledOnce()
    expect(registrations.performance).toHaveBeenCalledOnce()
    expect(registration.dispose).toBe(registrations.dispose)
  })

  it("disposes event publishers when handler installation fails", () => {
    registrations.system.mockImplementationOnce(() => {
      throw new Error("registration failed")
    })
    expect(() => registerIpcHandlers(services() as never)).toThrow("registration failed")
    expect(registrations.dispose).toHaveBeenCalled()
  })
})

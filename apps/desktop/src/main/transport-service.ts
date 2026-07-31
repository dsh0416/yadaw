import type { TransportCommand, TransportSnapshot } from "@yadaw/contracts"
import type { AudioHostService } from "./audio-host-service"
import type { ProjectService } from "./project-service"

export class TransportService {
  private testSnapshot: TransportSnapshot = {
    state: "stopped",
    positionFrames: 0,
    sampleRate: 48_000
  }
  private commandTail: Promise<void> = Promise.resolve()

  constructor(
    private readonly projects: ProjectService,
    private readonly audioHost: AudioHostService | null
  ) {}

  command(command: TransportCommand): Promise<TransportSnapshot> {
    const result = this.commandTail.then(
      () => this.commandNow(command),
      () => this.commandNow(command)
    )
    this.commandTail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async commandNow(command: TransportCommand): Promise<TransportSnapshot> {
    if (
      process.env.YADAW_TEST_CAPTURE_SOURCE === "1" &&
      process.env.YADAW_TEST_MOCK_AUDIO !== "1"
    ) {
      this.testSnapshot.sampleRate =
        this.projects.current?.configuration.sampleRate ?? this.testSnapshot.sampleRate
      if (command.type === "seek") this.testSnapshot.positionFrames = command.positionFrames
      else if (command.type === "stop") {
        this.testSnapshot.state = "stopped"
        this.testSnapshot.positionFrames = 0
      } else if (command.type === "pause") this.testSnapshot.state = "stopped"
      else if (command.type === "play") this.testSnapshot.state = "playing"
      else if (command.type === "record") this.testSnapshot.state = "recording"
      else if (command.type === "record-count-in") this.testSnapshot.state = "counting-in"
      return { ...this.testSnapshot }
    }
    if (!this.audioHost) throw new Error("Audio host is not running")
    try {
      return await this.audioHost.transport(command)
    } catch (error) {
      if (
        (command.type === "stop" || command.type === "pause") &&
        error instanceof Error &&
        error.message.includes("audio engine must be running before transport")
      ) {
        return {
          state: "stopped",
          positionFrames: 0,
          sampleRate:
            this.projects.current?.configuration.sampleRate ?? this.testSnapshot.sampleRate
        }
      }
      throw error
    }
  }

  snapshot(): Promise<TransportSnapshot> {
    if (
      process.env.YADAW_TEST_CAPTURE_SOURCE === "1" &&
      process.env.YADAW_TEST_MOCK_AUDIO !== "1"
    ) {
      return Promise.resolve({ ...this.testSnapshot })
    }
    if (!this.audioHost) {
      return Promise.resolve({ state: "stopped", positionFrames: 0, sampleRate: 0 })
    }
    return this.audioHost.transportSnapshot()
  }
}

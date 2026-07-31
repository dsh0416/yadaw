import type { WaveformPeakWindow } from "@yadaw/contracts"

export class RecordingSessionController<T> {
  active: T | null = null
  lastWaveformSnapshot: WaveformPeakWindow | null = null

  begin(session: T): void {
    if (this.active) throw new Error("A recording is already active")
    this.lastWaveformSnapshot = null
    this.active = session
  }

  take(): T {
    const session = this.active
    if (!session) throw new Error("No recording is active")
    this.active = null
    return session
  }
}

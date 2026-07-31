import type { MixerParameterPreview, MixerRuntimeSnapshot } from "@yadaw/contracts"
import { finiteRange } from "@yadaw/project-model"
import type { AudioHostService } from "./audio-host-service"

export class MixerRuntimeService {
  constructor(private readonly audioHost: AudioHostService | null) {}

  async preview(preview: MixerParameterPreview): Promise<void> {
    finiteRange(
      preview.value,
      preview.parameter === "pan" ? -1 : -90,
      preview.parameter === "pan" ? 1 : 12,
      "Mixer preview"
    )
    await this.audioHost?.previewMixerParameter(preview)
  }

  runtimeSnapshot(): Promise<MixerRuntimeSnapshot> {
    return (
      this.audioHost?.mixerSnapshot() ?? Promise.resolve({ meters: [], capturedAt: Date.now() })
    )
  }

  clearMeterClips(): Promise<MixerRuntimeSnapshot> {
    return (
      this.audioHost?.clearMeterClips() ?? Promise.resolve({ meters: [], capturedAt: Date.now() })
    )
  }
}

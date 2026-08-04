import type { MixerParameterPreview, MixerRuntimeSnapshot } from "@heron/contracts"
import { finiteRange } from "@heron/project-model"
import type { AudioHostService } from "../audio-host"

export class MixerRuntimeService {
  constructor(private readonly audioHost: AudioHostService | null) {}

  async preview(preview: MixerParameterPreview): Promise<void> {
    const [minimum, maximum] =
      preview.target === "plugin" ? [0, 1] : preview.parameter === "pan" ? [-1, 1] : [-90, 12]
    finiteRange(preview.value, minimum, maximum, "Mixer preview")
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

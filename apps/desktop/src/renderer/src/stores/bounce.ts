import { acceptHMRUpdate, defineStore } from "pinia"
import { computed, shallowRef } from "vue"
import type {
  BounceFormatSettings,
  BounceNormalization,
  BounceOutputRequest,
  BounceSampleRate,
  MixerChannelState
} from "@heron/contracts"
import { musicalPositionAtTick } from "../utils/tempoMap"
import { mutationMeta, rpcErrorMessage } from "../rpc"
import { useProjectStore } from "./project"
import { useProjectGraphStore } from "./projectGraph"

function defaultFormat(): BounceFormatSettings {
  return { format: "wav", bitDepth: "pcm24", dither: "tpdf" }
}

export const useBounceStore = defineStore("bounce", () => {
  const projectStore = useProjectStore()
  const graphStore = useProjectGraphStore()
  const open = shallowRef(false)
  const targetOutput = shallowRef<MixerChannelState | null>(null)
  const sampleRate = shallowRef<BounceSampleRate>("project")
  const channelMode = shallowRef<"stereo" | "mono">("stereo")
  const format = shallowRef<BounceFormatSettings>(defaultFormat())
  const normalization = shallowRef<BounceNormalization>({ mode: "overload-protection" })
  const startBar = shallowRef(1)
  const endBar = shallowRef(1)
  const includeTail = shallowRef(true)
  const starting = shallowRef(false)
  const error = shallowRef("")

  const maximumBar = computed(() => {
    const endTick = Math.max(1, graphStore.graph.projectEndTick ?? 1)
    return musicalPositionAtTick(graphStore.graph.tempoMap, endTick - 1).bar
  })
  const valid = computed(() => {
    const effectiveSampleRate =
      sampleRate.value === "project"
        ? projectStore.session?.configuration.sampleRate
        : sampleRate.value
    return (
      targetOutput.value?.kind === "output" &&
      Number.isSafeInteger(startBar.value) &&
      Number.isSafeInteger(endBar.value) &&
      startBar.value >= 1 &&
      endBar.value >= startBar.value &&
      endBar.value <= maximumBar.value &&
      !(format.value.format === "mp3" && ![44_100, 48_000].includes(effectiveSampleRate ?? 0))
    )
  })

  function openFor(channel: MixerChannelState): void {
    if (channel.kind !== "output") return
    targetOutput.value = structuredClone(channel)
    sampleRate.value = "project"
    channelMode.value = "stereo"
    format.value = defaultFormat()
    normalization.value = { mode: "overload-protection" }
    startBar.value = 1
    endBar.value = maximumBar.value
    includeTail.value = true
    error.value = ""
    open.value = true
  }

  function close(): void {
    if (!starting.value) open.value = false
  }

  function setFormat(next: BounceFormatSettings): void {
    format.value = structuredClone(next)
    if (next.format === "mp3" && sampleRate.value !== "project" && sampleRate.value > 48_000) {
      sampleRate.value = 48_000
    }
  }

  async function start(): Promise<boolean> {
    const output = targetOutput.value
    const target = projectStore.projectGraphRef
    if (!valid.value || !output || !target) return false
    starting.value = true
    error.value = ""
    const request: BounceOutputRequest = {
      outputChannelId: output.id,
      sampleRate: sampleRate.value,
      channelMode: channelMode.value,
      format: structuredClone(format.value),
      normalization: structuredClone(normalization.value),
      startBar: startBar.value,
      endBar: endBar.value,
      includeTail: includeTail.value
    }
    try {
      const result = await window.heron.startBounceOutput(
        mutationMeta(target, "bounce-output", projectStore.projectRevision),
        request
      )
      if (!result.ok) {
        error.value = rpcErrorMessage(result.error)
        return false
      }
      if (!result.value) return false
      open.value = false
      return true
    } finally {
      starting.value = false
    }
  }

  return {
    open,
    targetOutput,
    sampleRate,
    channelMode,
    format,
    normalization,
    startBar,
    endBar,
    includeTail,
    maximumBar,
    starting,
    error,
    valid,
    openFor,
    close,
    setFormat,
    start
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useBounceStore, import.meta.hot))
}

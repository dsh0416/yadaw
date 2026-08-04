import type { ProjectGraphSnapshot } from "@heron/contracts"
import type { AudioHostGraph } from "./wire"

export class AudioHostSessionCoordinator {
  graph: {
    revision: number
    project: ProjectGraphSnapshot
    runtime: AudioHostGraph
  } | null = null
  published: { revision: number; runtime: AudioHostGraph } | null = null
  recovery: Promise<void> | null = null
  reconfiguring = false
}

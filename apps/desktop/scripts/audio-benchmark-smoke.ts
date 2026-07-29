import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@yadaw/audio-host-client"

interface BenchmarkScenario {
  plugins: number
  measured_blocks: number
  p99_block_ms: number
}

interface WireResponse {
  result: {
    type: string
    message?: string
    report?: {
      overall_realtime_factor: number
      worst_p99_deadline_utilization_percent: number
      scenarios: BenchmarkScenario[]
    }
  }
}

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const helperPath = resolve(repositoryRoot, "target", "debug", `yadaw-audio-host${executableSuffix}`)
const pluginPath = resolve(repositoryRoot, "target", "bundles", "YADAW Gain.vst3")
const client = new AudioHostIpcClient(
  helperPath,
  resolve(tmpdir(), `yadaw-audio-benchmark-${process.pid}.marker`),
  2,
  4,
  2
)

let requestId = 1
async function request(command: unknown): Promise<WireResponse["result"]> {
  const response = await client.request(
    Buffer.from(encode({ request_id: requestId++, command })),
    []
  )
  const decoded = decode(response.body) as WireResponse
  if (decoded.result.type === "error") {
    throw new Error(decoded.result.message ?? "audio-host request failed")
  }
  return decoded.result
}

const pluginInstanceIds = Array.from(
  { length: 64 },
  (_, index) => `__yadaw-audio-benchmark-gain-${index}`
)

try {
  await Promise.all(
    pluginInstanceIds.map(async (instanceId) => {
      const loaded = await request({
        type: "load-plugin",
        instance_id: instanceId,
        module_path: pluginPath,
        class_id: "59CABE21E605B9C9EE928D6C3B236BBF",
        plugin_kind: "effect",
        audio_mode: "stereo",
        sample_rate: 48_000,
        component_state: { storage: "inline", bytes: new Uint8Array() },
        controller_state: { storage: "inline", bytes: new Uint8Array() }
      })
      if (loaded.type !== "plugin-loaded") throw new Error("VST3 load response mismatch")
    })
  )

  const result = await request({
    type: "run-audio-benchmark",
    plugin_instance_ids: pluginInstanceIds
  })
  const report = result.report
  if (
    result.type !== "audio-benchmark" ||
    !report ||
    report.scenarios.length !== 3 ||
    report.scenarios.some((scenario) => scenario.measured_blocks === 0) ||
    report.scenarios.map((scenario) => scenario.plugins).join(",") !== "8,32,64" ||
    !Number.isFinite(report.overall_realtime_factor) ||
    !Number.isFinite(report.worst_p99_deadline_utilization_percent)
  ) {
    throw new Error("audio benchmark report mismatch")
  }

  console.log(
    `Audio benchmark VST3 smoke passed (${report.scenarios
      .map((scenario) => `${scenario.plugins} plug-ins/${scenario.p99_block_ms.toFixed(3)} ms p99`)
      .join(", ")})`
  )
} finally {
  try {
    await client.heartbeat(
      Buffer.from(
        encode({
          request_id: requestId++,
          command: { type: "shutdown" }
        })
      )
    )
  } finally {
    client.close()
  }
}

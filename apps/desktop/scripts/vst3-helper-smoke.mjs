import { spawn, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const bridgeFilename = process.platform === "win32"
  ? "yadaw-vst3-bridge.dll"
  : process.platform === "darwin"
    ? "libyadaw-vst3-bridge.dylib"
    : "libyadaw-vst3-bridge.so"
const [helperPath, bridgePath, pluginPath] = process.argv.slice(2)
const resolvedHelper = helperPath ?? resolve(
  repositoryRoot,
  "target",
  "debug",
  `yadaw-audio-host${executableSuffix}`
)
const resolvedBridge = bridgePath ?? resolve(
  repositoryRoot,
  "target",
  "vst3-fixtures",
  "bin",
  bridgeFilename
)
const resolvedPlugin = pluginPath ?? resolve(
  repositoryRoot,
  "target",
  "vst3-fixtures",
  "VST3",
  "Debug",
  "again.vst3"
)
const resolvedSynth = resolve(
  repositoryRoot,
  "target",
  "vst3-fixtures",
  "VST3",
  "Debug",
  "note-expression-synth.vst3"
)
const smokeExecutable = resolve(
  repositoryRoot,
  "target",
  "vst3-fixtures",
  "bin",
  `yadaw-vst3-smoke${executableSuffix}`
)
const smoke = spawnSync(smokeExecutable, [resolvedPlugin, resolvedSynth], {
  stdio: "inherit"
})
if (smoke.status !== 0) {
  throw new Error(`VST3 block-processing smoke test exited with ${smoke.status}`)
}

const child = spawn(resolvedHelper, ["--vst3-bridge", resolvedBridge], {
  stdio: ["pipe", "pipe", "inherit"]
})
let nextRequestId = 1
let received = Buffer.alloc(0)
const pending = new Map()

function send(command) {
  return new Promise((resolve, reject) => {
    const requestId = nextRequestId++
    pending.set(requestId, { resolve, reject })
    const payload = Buffer.from(encode({
      version: 1,
      request_id: requestId,
      command
    }))
    const frame = Buffer.alloc(payload.length + 4)
    frame.writeUInt32BE(payload.length, 0)
    payload.copy(frame, 4)
    child.stdin.write(frame)
  })
}

child.stdout.on("data", (chunk) => {
  received = Buffer.concat([received, chunk])
  while (received.length >= 4 && received.length >= received.readUInt32BE(0) + 4) {
    const length = received.readUInt32BE(0)
    const response = decode(received.subarray(4, length + 4))
    received = received.subarray(length + 4)
    const waiter = pending.get(response.request_id)
    pending.delete(response.request_id)
    if (response.result.type === "error") {
      waiter.reject(new Error(response.result.message))
    } else {
      waiter.resolve(response.result)
    }
  }
})

try {
  const loaded = await send({
    type: "load-plugin",
    instance_id: "again-1",
    module_path: resolvedPlugin,
    class_id: "84E8DE5F92554F5396FAE4133C935A18",
    sample_rate: 48_000,
    component_state: new Uint8Array(),
    controller_state: new Uint8Array()
  })
  if (loaded.type !== "plugin-loaded") throw new Error("load response mismatch")
  const listed = await send({ type: "plugin-parameters", instance_id: "again-1" })
  if (listed.type !== "plugin-parameters" || listed.parameters.length === 0) {
    throw new Error("AGain did not expose parameters")
  }
  const parameter = listed.parameters[0]
  for (const gesture of ["begin", "perform", "end"]) {
    await send({
      type: "set-plugin-parameter",
      instance_id: "again-1",
      parameter_id: parameter.id,
      normalized: 0.25,
      gesture
    })
  }
  const state = await send({ type: "save-plugin-state", instance_id: "again-1" })
  if (state.type !== "plugin-state" || !(state.component_state instanceof Uint8Array)) {
    throw new Error("state response mismatch")
  }
  console.log(
    `AGain helper round-trip passed (${listed.parameters.length} parameters, ` +
    `${state.component_state.length} component bytes)`
  )
  await send({ type: "shutdown" })
} catch (error) {
  child.kill()
  throw error
}

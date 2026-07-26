import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { decode, encode } from "@msgpack/msgpack"
import { AudioHostIpcClient } from "@yadaw/audio-host-client"

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..")
const executableSuffix = process.platform === "win32" ? ".exe" : ""
const bridgeFilename =
  process.platform === "win32"
    ? "yadaw-vst3-bridge.dll"
    : process.platform === "darwin"
      ? "libyadaw-vst3-bridge.dylib"
      : "libyadaw-vst3-bridge.so"
const client = new AudioHostIpcClient(
  resolve(repositoryRoot, "target", "debug", `yadaw-audio-host${executableSuffix}`),
  resolve(repositoryRoot, "target", "vst3-bridge-build", "bin", bridgeFilename),
  resolve(tmpdir(), `yadaw-ipc-v3-${process.pid}.marker`),
  2,
  4,
  2
)
let requestId = 1

async function request(command, attachments = []) {
  const response = await client.request(
    Buffer.from(
      encode({
        version: 3,
        request_id: requestId++,
        command
      })
    ),
    attachments
  )
  return { decoded: decode(response.body), attachments: response.attachments }
}

try {
  const heartbeat = decode(
    (
      await client.heartbeat(
        Buffer.from(
          encode({
            version: 3,
            request_id: requestId++,
            command: { type: "heartbeat" }
          })
        )
      )
    ).body
  )
  if (heartbeat.result.type !== "heartbeat" || heartbeat.result.egress_active === undefined) {
    throw new Error("priority heartbeat diagnostics mismatch")
  }

  const pong = await request({ type: "ping" })
  if (!["pong", "heartbeat"].includes(pong.decoded.result.type)) {
    throw new Error(`ping response mismatch: ${JSON.stringify(pong.decoded)}`)
  }

  const payload = Buffer.alloc(4 * 1024 * 1024, 0x5a)
  const echoed = await request(
    {
      type: "benchmark-echo",
      payload: {
        storage: "attachment",
        index: 0,
        offset: 0,
        length: payload.byteLength
      }
    },
    [payload]
  )
  const reference = echoed.decoded.result.payload
  const returned = echoed.attachments[reference.index]?.subarray(
    reference.offset,
    reference.offset + reference.length
  )
  if (
    echoed.decoded.result.type !== "benchmark-echo" ||
    returned?.byteLength !== payload.byteLength ||
    returned[0] !== 0x5a
  ) {
    throw new Error("4 MiB attachment response mismatch")
  }

  const diagnostics = decode(client.transportDiagnostics())
  if (diagnostics[0] !== 3 || diagnostics[8][0] !== 2 || diagnostics[8][2] !== 2) {
    throw new Error("runtime diagnostics mismatch")
  }
  console.log(
    `IPC v3 smoke passed (${returned.byteLength} bytes, ${diagnostics[8][3]} client arena region)`
  )

  const shutdownId = requestId++
  await client.heartbeat(
    Buffer.from(
      encode({
        version: 3,
        request_id: shutdownId,
        command: { type: "shutdown" }
      })
    )
  )
} finally {
  client.close()
}

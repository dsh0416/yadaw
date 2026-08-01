import { open } from "node:fs/promises"

function checksum(bytes: Uint8Array): number {
  let value = 0x811c_9dc5
  for (const byte of bytes) {
    value = Math.imul(value ^ byte, 0x0100_0193) >>> 0
  }
  return value
}

function encodeString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8")
  const length = Buffer.alloc(2)
  length.writeUInt16LE(bytes.length)
  return Buffer.concat([length, bytes])
}

function encodeCheckpoint(value: number | null): Buffer {
  const buffer = Buffer.alloc(9)
  buffer.writeUInt8(value === null ? 0 : 1, 0)
  buffer.writeBigUInt64LE(BigInt(value ?? 0), 1)
  return buffer
}

export const MidiJournalWriter = {
  async write(
    path: string,
    input: {
      sourceId: string
      clipId: string
      trackId: string
      records: Array<{ tick: number; bytes: number[] }>
    }
  ): Promise<void> {
    const handle = await open(path, "w")
    try {
      await handle.write(Buffer.from("YDMIDIJ1"))
      const version = Buffer.alloc(2)
      version.writeUInt16LE(1)
      await handle.write(version)
      await handle.write(encodeString(input.sourceId))
      await handle.write(encodeString(input.clipId))
      await handle.write(encodeString(input.trackId))
      for (const [index, record] of input.records.entries()) {
        const payloadParts = [
          (() => {
            const timestamp = Buffer.alloc(8)
            timestamp.writeBigUInt64LE(BigInt(index + 1))
            return timestamp
          })(),
          encodeCheckpoint(0),
          encodeCheckpoint(record.tick),
          (() => {
            const port = Buffer.alloc(8)
            port.writeBigUInt64LE(7n)
            return port
          })(),
          (() => {
            const count = Buffer.alloc(4)
            count.writeUInt32LE(record.bytes.length)
            return count
          })(),
          Buffer.from(record.bytes)
        ]
        const payload = Buffer.concat(payloadParts)
        const prefix = Buffer.alloc(8)
        prefix.writeUInt32LE(payload.length, 0)
        prefix.writeUInt32LE(checksum(payload), 4)
        await handle.write(prefix)
        await handle.write(payload)
      }
    } finally {
      await handle.close()
    }
  }
}

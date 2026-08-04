export type BinaryPayloadWire =
  | { storage: "inline"; bytes: Uint8Array }
  | { storage: "attachment"; index: number; offset: number; length: number }

export function inlineBinary(bytes: Uint8Array): BinaryPayloadWire {
  return { storage: "inline", bytes }
}

export function binaryBytes(payload?: BinaryPayloadWire): Uint8Array {
  return payload?.storage === "inline" ? payload.bytes : new Uint8Array()
}

export function extractLargeAttachments(value: unknown, attachments: Buffer[]): void {
  if (!value || typeof value !== "object") return
  if (
    "storage" in value &&
    "bytes" in value &&
    value.storage === "inline" &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength > 64 * 1024
  ) {
    const payload = value as {
      storage: string
      bytes?: Uint8Array
      index?: number
      offset?: number
      length?: number
    }
    const bytes = Buffer.from(
      payload.bytes!.buffer,
      payload.bytes!.byteOffset,
      payload.bytes!.byteLength
    )
    payload.storage = "attachment"
    payload.index = attachments.length
    payload.offset = 0
    payload.length = bytes.byteLength
    delete payload.bytes
    attachments.push(bytes)
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) extractLargeAttachments(child, attachments)
    return
  }
  for (const child of Object.values(value)) extractLargeAttachments(child, attachments)
}

export function hydrateAttachments(value: unknown, attachments: readonly Buffer[]): void {
  if (!value || typeof value !== "object") return
  if (
    "storage" in value &&
    "index" in value &&
    value.storage === "attachment" &&
    typeof value.index === "number"
  ) {
    const payload = value as {
      storage: string
      index?: number
      offset?: number
      length?: number
      bytes?: Uint8Array
    }
    const attachment = attachments[payload.index!]
    const offset = payload.offset ?? 0
    const length = payload.length ?? attachment?.byteLength ?? 0
    if (!attachment || offset < 0 || length < 0 || offset + length > attachment.byteLength) {
      throw new Error("audio host returned an invalid attachment reference")
    }
    payload.storage = "inline"
    payload.bytes = attachment.subarray(offset, offset + length)
    delete payload.index
    delete payload.offset
    delete payload.length
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) hydrateAttachments(child, attachments)
    return
  }
  for (const child of Object.values(value)) hydrateAttachments(child, attachments)
}

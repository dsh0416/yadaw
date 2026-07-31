import { normalizePluginDescriptor, type PluginDescriptor } from "@yadaw/contracts"

export function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  }
  return new Uint8Array()
}

export function pluginDescriptor(snapshot: string): PluginDescriptor {
  return normalizePluginDescriptor(JSON.parse(snapshot) as PluginDescriptor & { category?: string })
}

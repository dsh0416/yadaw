import type { AppLocale } from "@yadaw/contracts"

export const APP_LOCALES = ["en-US", "zh-cmn-Hans-CN"] as const satisfies readonly AppLocale[]

export const DEFAULT_LOCALE: AppLocale = "en-US"

export type MessageTree = { readonly [key: string]: string | MessageTree }

export function isAppLocale(value: unknown): value is AppLocale {
  return value === "en-US" || value === "zh-cmn-Hans-CN"
}

export function translate(
  messages: MessageTree,
  key: string,
  params?: Readonly<Record<string, string | number>>
): string {
  const parts = key.split(".")
  let node: string | MessageTree | undefined = messages
  for (const part of parts) {
    if (!node || typeof node === "string") return key
    node = node[part]
  }
  if (typeof node !== "string") return key
  if (!params) return node
  return node.replace(/\{(\w+)\}/gu, (match, name: string) =>
    params[name] === undefined ? match : String(params[name])
  )
}

export function rekaLocale(locale: AppLocale): string {
  return locale === "zh-cmn-Hans-CN" ? "zh" : "en"
}

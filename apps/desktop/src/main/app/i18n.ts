import type { AppLocale } from "@heron/contracts"
import enUS from "../../locales/en-US.json"
import zhCmnHansCN from "../../locales/zh-cmn-Hans-CN.json"
import { DEFAULT_LOCALE, isAppLocale, translate, type MessageTree } from "../../shared/i18n"

const catalogs: Record<AppLocale, MessageTree> = {
  "en-US": enUS,
  "zh-cmn-Hans-CN": zhCmnHansCN
}

let currentLocale: AppLocale = DEFAULT_LOCALE

export function getMainLocale(): AppLocale {
  return currentLocale
}

export function setMainLocale(locale: unknown): AppLocale {
  currentLocale = isAppLocale(locale) ? locale : DEFAULT_LOCALE
  return currentLocale
}

export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const localized = translate(catalogs[currentLocale], key, params)
  if (localized !== key || currentLocale === DEFAULT_LOCALE) return localized
  return translate(catalogs[DEFAULT_LOCALE], key, params)
}

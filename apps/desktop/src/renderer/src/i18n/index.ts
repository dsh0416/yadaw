import { createI18n } from "vue-i18n"
import type { AppLocale } from "@heron/contracts"
import enUS from "../../../locales/en-US.json"
import zhCmnHansCN from "../../../locales/zh-cmn-Hans-CN.json"
import { DEFAULT_LOCALE } from "../../../shared/i18n"

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  fallbackLocale: DEFAULT_LOCALE,
  messages: {
    "en-US": enUS,
    "zh-cmn-Hans-CN": zhCmnHansCN
  }
})

export function setAppLocale(locale: AppLocale): void {
  i18n.global.locale.value = locale
}

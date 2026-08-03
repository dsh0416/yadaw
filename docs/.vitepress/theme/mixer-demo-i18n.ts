import { createI18n } from "vue-i18n"
import enUS from "../../../apps/desktop/src/locales/en-US.json"
import zhCmnHansCN from "../../../apps/desktop/src/locales/zh-cmn-Hans-CN.json"

export function createMixerDemoI18n() {
  return createI18n({
    legacy: false,
    locale: "en-US",
    fallbackLocale: "en-US",
    messages: {
      "en-US": enUS,
      "zh-cmn-Hans-CN": zhCmnHansCN
    }
  })
}

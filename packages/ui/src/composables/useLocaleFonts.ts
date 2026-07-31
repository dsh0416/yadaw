import { useHead } from "@unhead/vue"
import { computed, toValue, watch, type MaybeRefOrGetter } from "vue"
import { htmlLangForFontLocale } from "../../fonts"

let hansFontsPromise: Promise<unknown> | null = null

function ensureHansFonts(): Promise<unknown> {
  hansFontsPromise ??= import("@fontsource-variable/noto-sans-sc/wght.css")
  return hansFontsPromise
}

/**
 * Keep `html lang` aligned with the active locale via Unhead, and load the
 * Simplified Chinese face when Hans UI is selected. Latin faces stay in
 * `unfonts.css`; `:lang(zh*)` token overrides prefer Noto Sans SC Variable.
 */
export function useLocaleFonts(locale: MaybeRefOrGetter<string>): void {
  const documentLang = computed(() => htmlLangForFontLocale(toValue(locale)))

  useHead({
    htmlAttrs: {
      lang: documentLang
    }
  })

  watch(
    documentLang,
    (lang) => {
      if (lang === "zh-CN") void ensureHansFonts()
    },
    { immediate: true }
  )
}

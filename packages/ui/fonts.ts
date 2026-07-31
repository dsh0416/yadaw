import type { Options } from "unplugin-fonts/types"

/**
 * Shared unplugin-fonts options for the desktop renderer, Storybook, and docs.
 * Fontsource packages are bundled so Electron CSP (`font-src 'self'`) and offline
 * use stay intact; consumers must import `unfonts.css` from their Vite entry.
 *
 * Locale-specific faces (for example Noto Sans SC for Chinese) are loaded through
 * Unhead once the active document language is known — see `htmlLangForFontLocale`.
 */
export const yadawFontsOptions = {
  fontsource: {
    families: [
      {
        name: "Inter Variable",
        variable: { wght: true }
      },
      {
        name: "Barlow Condensed",
        weights: [400, 500, 600, 700],
        styles: ["normal"],
        subset: "latin"
      },
      {
        name: "Cascadia Mono Variable",
        variable: { wght: true }
      }
    ]
  }
} satisfies Options

/** Locales that should load the Hans CJK interface face. */
const HANS_FONT_LOCALES = new Set(["zh-cmn-Hans-CN", "zh-CN", "zh-Hans", "zh"])

/**
 * Map a product / VitePress locale id to the BCP-47 `html lang` value used for
 * OpenType language features and `:lang(...)` font stacks.
 */
export function htmlLangForFontLocale(locale: string): string {
  if (HANS_FONT_LOCALES.has(locale) || locale.startsWith("zh")) return "zh-CN"
  return "en-US"
}

/** Whether the locale should load the bundled Simplified Chinese face. */
export function localeNeedsHansFonts(locale: string): boolean {
  return htmlLangForFontLocale(locale) === "zh-CN"
}

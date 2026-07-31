import { describe, expect, it } from "vitest"
import { htmlLangForFontLocale, localeNeedsHansFonts } from "./fonts"

describe("font locale helpers", () => {
  it("maps English product locales to en-US", () => {
    expect(htmlLangForFontLocale("en-US")).toBe("en-US")
    expect(localeNeedsHansFonts("en-US")).toBe(false)
  })

  it("maps Chinese product and docs locales to zh-CN", () => {
    expect(htmlLangForFontLocale("zh-cmn-Hans-CN")).toBe("zh-CN")
    expect(htmlLangForFontLocale("zh-CN")).toBe("zh-CN")
    expect(htmlLangForFontLocale("zh")).toBe("zh-CN")
    expect(localeNeedsHansFonts("zh-cmn-Hans-CN")).toBe(true)
  })
})

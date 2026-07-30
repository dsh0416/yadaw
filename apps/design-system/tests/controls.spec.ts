import { expect, test } from "@playwright/test"

test("cascading select menus use compact dropdown typography", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-forms-field--select-sizes-and-groups&viewMode=story&globals=theme:dark;motion:disabled"
  )

  const trigger = page.locator(".ui-cascading-select").first()
  await expect(trigger).toBeVisible()
  await trigger.click()

  const buses = page.getByRole("menuitem", { name: "Buses" })
  await expect(buses).toHaveCSS("font-size", "9px")
  await buses.hover()

  const bus = page.getByRole("menuitemradio", { name: "Reverb" })
  await expect(bus).toBeVisible()
  await expect(bus).toHaveCSS("font-size", "9px")
})

test("direct select options keep their indicator column and stay on one line", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-forms-field--select-sizes-and-groups&viewMode=story&globals=theme:dark;motion:disabled"
  )

  const trigger = page.locator(".ui-cascading-select").nth(1)
  await expect(trigger).toBeVisible()
  await trigger.click()

  const options = page.getByRole("menuitemradio")
  await expect(options).toHaveCount(4)
  const layout = await options.evaluateAll((items) =>
    items.map((item) => {
      const label = item.lastElementChild
      const itemBounds = item.getBoundingClientRect()
      const labelBounds = label?.getBoundingClientRect()
      return {
        itemHeight: itemBounds.height,
        labelHeight: labelBounds?.height ?? 0,
        labelX: labelBounds?.x ?? 0
      }
    })
  )

  expect(new Set(layout.map(({ labelX }) => Math.round(labelX))).size).toBe(1)
  expect(layout.every(({ itemHeight, labelHeight }) => itemHeight <= 30 && labelHeight < 20)).toBe(
    true
  )
})

test("global key and meter track accent colors are defined", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-forms-field--select-sizes-and-groups&viewMode=story&globals=theme:dark;motion:disabled"
  )

  const colors = await page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement)
    return {
      key: styles.getPropertyValue("--ui-domain-color-b894ff").trim(),
      meter: styles.getPropertyValue("--ui-domain-color-f2a65a").trim()
    }
  })

  expect(colors).toEqual({ key: "#b894ff", meter: "#f2a65a" })
})

test("workspace tool modes use roving focus and persistent pressed state", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-workspace-command-surfaces--editor-toolbar&viewMode=story&globals=theme:dark;motion:disabled"
  )

  const select = page.getByRole("button", { name: "Select" })
  const draw = page.getByRole("button", { name: "Draw" })
  await expect(select).toHaveAttribute("aria-pressed", "true")

  await select.focus()
  await select.press("ArrowRight")

  await expect(draw).toBeFocused()
  await draw.press("Enter")
  await expect(draw).toHaveAttribute("aria-pressed", "true")
  await expect(select).toHaveAttribute("aria-pressed", "false")
})

test("workspace clip choices pair the signal rail with text state", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-workspace-command-surfaces--editor-toolbar&viewMode=story&globals=theme:light;motion:disabled"
  )

  const verse = page.getByRole("button", { name: "Verse" })
  const counterMelody = page.getByRole("button", { name: "Counter melody" })
  await expect(verse).toHaveAttribute("aria-pressed", "true")
  await expect(verse).toHaveCSS("border-left-width", "3px")

  await counterMelody.click()
  await expect(counterMelody).toHaveAttribute("aria-pressed", "true")
  await expect(verse).toHaveAttribute("aria-pressed", "false")
})

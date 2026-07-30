import { expect, test } from "@playwright/test"

const reflowStories = [
  "product-examples-welcome--welcome",
  "product-examples-welcome--settings",
  "components-overlays-dialog--destructive-confirmation"
] as const

for (const id of reflowStories) {
  test(`${id} reflows at 320 CSS px and 200% text`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 })
    await page.goto(`/iframe.html?id=${id}&viewMode=story&globals=theme:dark;motion:disabled`)
    await expect(page.locator(".storybook-stage")).toBeVisible()

    await page.addStyleTag({ content: "html { font-size: 200% !important; }" })
    const viewportOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    expect(viewportOverflow).toBeLessThanOrEqual(1)
  })
}

test("mixer keeps two-dimensional overflow inside its workspace", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto(
    "/iframe.html?id=product-examples-welcome--mixer-controls&viewMode=story&globals=theme:dark;motion:disabled"
  )

  const localScroller = page.locator(".mixer-example-scroll")
  await expect(localScroller).toBeVisible()
  await expect
    .poll(() => localScroller.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true)
})

test("workspace toolbar keeps overflow local at 320 CSS px and 200% text", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 })
  await page.goto(
    "/iframe.html?id=components-workspace-command-surfaces--editor-toolbar&viewMode=story&globals=theme:dark;motion:disabled"
  )

  await page.addStyleTag({ content: "html { font-size: 200% !important; }" })
  const toolbar = page.getByRole("toolbar", { name: "Piano roll commands" })
  await expect(toolbar).toBeVisible()
  await expect(page.getByRole("button", { name: "Close editor" })).toBeVisible()
  const viewportOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  )
  expect(viewportOverflow).toBeLessThanOrEqual(1)
})

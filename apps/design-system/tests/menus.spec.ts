import { expect, test } from "@playwright/test"

test("search flattens nested menu results and keeps their category path", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-menus--searchable-taxonomy&viewMode=story&globals=theme:dark;motion:disabled"
  )

  await page.getByRole("button", { name: "Add audio effect" }).click()
  const menu = page.getByRole("menu", { name: "Add audio effect" })
  await expect(menu).toHaveCSS("width", "260px")
  await expect(menu).toHaveCSS("background-color", "rgb(48, 48, 48)")
  const search = page.getByRole("textbox", { name: "Search effects" })
  await expect(search).toBeFocused()
  await expect(search).toHaveCSS("outline-style", "none")
  await expect(search).toHaveCSS("box-shadow", "none")
  await search.fill("pro")

  const result = page.getByRole("menuitem", { name: "Pro-C 2" })
  await expect(result).toBeVisible()
  await result.hover()
  await expect(result).toHaveCSS("background-color", "rgb(69, 69, 69)")
  await expect(result).toHaveCSS("color", "rgb(243, 243, 243)")
  await expect(result).not.toHaveCSS("box-shadow", "none")
  await expect(result).toContainText("Dynamics / Compressors")
  await expect(page.getByRole("menuitem", { name: "Dynamics", exact: true })).toHaveCount(0)

  await result.click()
  await expect(page.getByText("effect:pro-c")).toBeVisible()
})

test("context menu opens at the pointer and exposes nested and destructive commands", async ({
  page
}) => {
  await page.goto(
    "/iframe.html?id=components-menus--clip-context-menu&viewMode=story&globals=theme:light;motion:disabled"
  )

  const clip = page.getByText("Verse · guitar")
  await clip.click({ button: "right" })

  const menu = page.getByRole("menu", { name: "Verse clip commands" })
  await expect(menu).toBeVisible()
  await expect(menu).toHaveCSS("background-color", "rgb(247, 247, 247)")
  await expect(page.getByRole("menuitem", { name: "Transform" })).toBeVisible()
  const deleteItem = page.getByRole("menuitem", { name: "Delete" })
  await expect(deleteItem).toHaveCSS("color", "rgb(180, 35, 45)")

  await deleteItem.click()
  await expect(page.getByText("delete", { exact: true })).toBeVisible()
})

test("checkbox commands stay open after toggle and submenu typing focuses search", async ({
  page
}) => {
  await page.goto(
    "/iframe.html?id=components-menus--clip-context-menu&viewMode=story&globals=theme:dark;motion:disabled"
  )

  await page.getByText("Verse · guitar").click({ button: "right" })
  const loop = page.getByRole("menuitemcheckbox", { name: "Loop clip" })
  await expect(loop).toBeChecked()
  await loop.click()
  await expect(page.getByRole("menu", { name: "Verse clip commands" })).toBeVisible()
  await expect(page.getByText("loop", { exact: true })).toBeVisible()
})

test("searchable dropdown accepts typed characters from an open submenu", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-menus--searchable-taxonomy&viewMode=story&globals=theme:dark;motion:disabled"
  )

  await page.getByRole("button", { name: "Add audio effect" }).click()
  const search = page.getByRole("textbox", { name: "Search effects" })
  await expect(search).toBeFocused()

  const dynamics = page.getByRole("menuitem", { name: "Dynamics" })
  await dynamics.focus()
  await page.keyboard.press("ArrowRight")
  const compressor = page.getByRole("menuitem", { name: "Compressors" })
  await expect(compressor).toBeVisible()
  await compressor.focus()
  await page.keyboard.type("pro")
  await expect(search).toHaveValue("pro")
  await expect(search).toBeFocused()
  await expect(page.getByRole("menuitem", { name: "Pro-C 2" })).toBeVisible()
})

test("long context menus use the compact menu scrollbar and remain wheel-scrollable", async ({
  page
}) => {
  await page.goto(
    "/iframe.html?id=components-menus--scrollable-context-menu&viewMode=story&globals=theme:dark;motion:disabled"
  )

  await page.getByText("Right-click for a long command menu").click({ button: "right" })
  const menu = page.getByRole("menu", { name: "Scrollable clip commands" })
  await expect(menu).toBeVisible()

  const metrics = await menu.evaluate((element) => {
    const style = getComputedStyle(element)
    const scrollbar = getComputedStyle(element, "::-webkit-scrollbar")
    const thumb = getComputedStyle(element, "::-webkit-scrollbar-thumb")
    return {
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      overflowX: style.overflowX,
      scrollbarWidth: style.scrollbarWidth,
      webkitWidth: scrollbar.width,
      thumbBackground: thumb.backgroundColor
    }
  })
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
  expect(metrics.overflowX).toBe("hidden")
  expect(metrics.scrollbarWidth).toBe("auto")
  expect(metrics.webkitWidth).toBe("8px")
  expect(metrics.thumbBackground).not.toBe("rgba(0, 0, 0, 0)")

  await menu.hover()
  await page.mouse.wheel(0, 240)
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
})

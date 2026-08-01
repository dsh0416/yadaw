import { expect, test } from "@playwright/test"

test("search flattens nested menu results and keeps their category path", async ({ page }) => {
  await page.goto(
    "/iframe.html?id=components-menus--searchable-taxonomy&viewMode=story&globals=theme:dark;motion:disabled"
  )

  await page.getByRole("button", { name: "Add audio effect" }).click()
  const search = page.getByRole("textbox", { name: "Search effects" })
  await expect(search).toBeFocused()
  await search.fill("pro")

  const result = page.getByRole("menuitem", { name: "Pro-C 2" })
  await expect(result).toBeVisible()
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

  await expect(page.getByRole("menu", { name: "Verse clip commands" })).toBeVisible()
  await expect(page.getByRole("menuitem", { name: "Transform" })).toBeVisible()
  const deleteItem = page.getByRole("menuitem", { name: "Delete" })
  await expect(deleteItem).toHaveCSS("color", "rgb(180, 35, 45)")

  await deleteItem.click()
  await expect(page.getByText("delete", { exact: true })).toBeVisible()
})

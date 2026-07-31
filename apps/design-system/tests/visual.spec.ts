import { expect, test } from "@playwright/test"

const stories = [
  ["actions", "components-actions-button--all-variants-and-sizes"],
  ["forms", "components-forms-field--complete-form"],
  ["dialog", "components-overlays-dialog--destructive-confirmation"],
  ["loading", "components-feedback-status--loading"],
  ["error", "patterns-async-states--error"],
  ["welcome", "product-examples-welcome--welcome"],
  ["settings", "product-examples-welcome--settings"],
  ["operation", "patterns-async-states--long-running-operation"],
  ["midi-import", "product-examples-welcome--midi-import"],
  ["benchmark", "product-examples-welcome--benchmark"]
] as const

test.describe("visual baselines", () => {
  for (const theme of ["dark", "light"] as const) {
    test(`color · ${theme}`, async ({ page }) => {
      await page.goto(
        `/iframe.html?id=foundations-color--documentation&viewMode=docs&globals=theme:${theme};motion:disabled`
      )
      await expect(page.locator(".sbdocs-content")).toBeVisible()
      await expect(page).toHaveScreenshot(`color-${theme}.png`, {
        animations: "disabled",
        caret: "hide",
        scale: "css",
        maxDiffPixelRatio: 0.005
      })
    })

    for (const [name, id] of stories) {
      test(`${name} · ${theme}`, async ({ page }) => {
        await page.goto(
          `/iframe.html?id=${id}&viewMode=story&globals=theme:${theme};motion:disabled`
        )
        await expect(page.locator(".storybook-stage")).toBeVisible()
        await expect(page).toHaveScreenshot(`${name}-${theme}.png`, {
          animations: "disabled",
          caret: "hide",
          scale: "css",
          maxDiffPixelRatio: 0.005
        })
      })
    }
  }
})

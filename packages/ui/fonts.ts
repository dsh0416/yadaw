import type { Options } from "unplugin-fonts/types"

/**
 * Shared unplugin-fonts options for the desktop renderer, Storybook, and docs.
 * Fontsource packages are bundled so Electron CSP (`font-src 'self'`) and offline
 * use stay intact; consumers must import `unfonts.css` from their Vite entry.
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

import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import type { StorybookConfig } from "@storybook/vue3-vite"
import { heronFontsOptions } from "@heron/ui/fonts"
import vue from "@vitejs/plugin-vue"
import Unfonts from "unplugin-fonts/vite"

const configDirectory = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = resolve(configDirectory, "../../..")

const config: StorybookConfig = {
  stories: [
    "../../../packages/ui/src/**/*.stories.ts",
    "../src/**/*.mdx",
    "../src/**/*.stories.ts"
  ],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "@storybook/addon-themes",
    "@storybook/addon-vitest"
  ],
  framework: {
    name: "@storybook/vue3-vite",
    options: {
      docgen: "vue-component-meta"
    }
  },
  docs: {
    defaultName: "Documentation"
  },
  async viteFinal(viteConfig) {
    const plugins = (viteConfig.plugins ?? []).filter((plugin) => {
      if (!plugin || typeof plugin !== "object" || !("name" in plugin)) return true
      return plugin.name !== "vite:vue"
    })
    const existingAliases = Array.isArray(viteConfig.resolve?.alias)
      ? viteConfig.resolve.alias
      : Object.entries(viteConfig.resolve?.alias ?? {}).map(([find, replacement]) => ({
          find,
          replacement
        }))

    return {
      ...viteConfig,
      plugins: [vue(), Unfonts(heronFontsOptions), ...plugins],
      resolve: {
        ...viteConfig.resolve,
        alias: [
          {
            find: /^@heron\/ui\/styles\.css$/,
            replacement: resolve(workspaceRoot, "packages/ui/src/styles/index.css")
          },
          {
            find: /^@heron\/ui\/fonts$/,
            replacement: resolve(workspaceRoot, "packages/ui/fonts.ts")
          },
          {
            find: /^@heron\/ui$/,
            replacement: resolve(workspaceRoot, "packages/ui/src/index.ts")
          },
          ...existingAliases
        ]
      },
      server: {
        ...viteConfig.server,
        fs: {
          ...viteConfig.server?.fs,
          allow: [workspaceRoot]
        }
      }
    }
  }
}

export default config

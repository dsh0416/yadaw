import { resolve } from "node:path"
import VueI18nPlugin from "@intlify/unplugin-vue-i18n/vite"
import vue from "@vitejs/plugin-vue"
import { heronFontsOptions } from "@heron/ui/fonts"
import Unfonts from "unplugin-fonts/vite"
import { defineConfig } from "vite"
import { appVersionDefine } from "./build/app-version.ts"
import { injectRendererContentSecurityPolicy } from "./src/shared/renderer-csp.ts"

export default defineConfig(({ command }) => ({
  base: "./",
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [
    {
      name: "heron-renderer-content-security-policy",
      transformIndexHtml: {
        order: "pre",
        handler: (html) => injectRendererContentSecurityPolicy(html, command === "build")
      }
    },
    vue(),
    Unfonts(heronFontsOptions),
    VueI18nPlugin({
      // Locale JSON is imported explicitly so the main process can share the same
      // catalogs as plain JSON without unplugin rewriting those modules.
      strictMessage: false,
      runtimeOnly: true
    })
  ],
  define: {
    __APP_VERSION__: appVersionDefine
  },
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "out/renderer"),
    rolldownOptions: {
      input: {
        main: resolve(import.meta.dirname, "src/renderer/index.html"),
        splash: resolve(import.meta.dirname, "src/renderer/splash.html")
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
}))

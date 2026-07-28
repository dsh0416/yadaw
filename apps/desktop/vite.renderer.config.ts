import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"

const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8")
) as { version: string }

export default defineConfig({
  base: "./",
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [vue()],
  define: {
    __APP_VERSION__: JSON.stringify(version)
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
})

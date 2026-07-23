import { resolve } from "node:path"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"

export default defineConfig({
  base: "./",
  root: resolve(import.meta.dirname, "src/renderer"),
  plugins: [vue()],
  build: {
    emptyOutDir: true,
    outDir: resolve(import.meta.dirname, "out/renderer")
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true
  }
})

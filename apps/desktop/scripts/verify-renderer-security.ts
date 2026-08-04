import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

const outputDirectory = resolve(import.meta.dirname, "../out/renderer")

for (const filename of ["index.html", "splash.html"]) {
  const html = await readFile(resolve(outputDirectory, filename), "utf8")
  if (html.includes("__HERON_CONTENT_SECURITY_POLICY__")) {
    throw new Error(`${filename} still contains the CSP placeholder`)
  }
  if (!html.includes("connect-src 'none'")) {
    throw new Error(`${filename} does not block production renderer connections`)
  }
  if (/\bws:|localhost/i.test(html)) {
    throw new Error(`${filename} contains a development websocket source`)
  }
}

console.log("Verified production CSP in index.html and splash.html")

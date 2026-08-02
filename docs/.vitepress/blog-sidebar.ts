import { readdirSync, readFileSync } from "node:fs"
import { extname, join, parse } from "node:path"
import { fileURLToPath } from "node:url"
import matter from "gray-matter"
import type { DefaultTheme } from "vitepress"

interface BlogSidebarEntry extends DefaultTheme.SidebarItem {
  date: string
}

const blogDirectory = fileURLToPath(new URL("../content/blog/", import.meta.url))

export function createBlogSidebar(): DefaultTheme.SidebarItem[] {
  const posts = readdirSync(blogDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md" && entry.name !== "index.md")
    .map(readBlogSidebarEntry)
    .filter((entry): entry is BlogSidebarEntry => entry !== undefined)
    .sort((a, b) => b.date.localeCompare(a.date))
    .map(({ text, link }) => ({ text, link }))

  return [{ text: "All posts", link: "/blog/" }, ...posts]
}

function readBlogSidebarEntry(entry: { name: string }): BlogSidebarEntry | undefined {
  const filename = join(blogDirectory, entry.name)
  const { data } = matter(readFileSync(filename, "utf8"))
  if (!data.date) {
    return undefined
  }

  return {
    text: String(data.title ?? "Untitled"),
    link: `/blog/${parse(entry.name).name}`,
    date: formatDate(data.date)
  }
}

function formatDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  return date.toISOString().slice(0, 10)
}

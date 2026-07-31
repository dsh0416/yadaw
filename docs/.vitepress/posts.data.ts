import { createContentLoader } from "vitepress"

export interface Post {
  title: string
  url: string
  date: string
  description: string
  tags: string[]
}

declare const data: Post[]
export { data }

export default createContentLoader("blog/*.md", {
  transform(raw): Post[] {
    return raw
      .filter(
        ({ url, frontmatter }) =>
          Boolean(frontmatter.date) && url !== "/blog/" && !url.endsWith("/blog/index.html")
      )
      .map(({ url, frontmatter }) => ({
        title: String(frontmatter.title ?? "Untitled"),
        url,
        date: formatDate(frontmatter.date),
        description: String(frontmatter.description ?? ""),
        tags: Array.isArray(frontmatter.tags)
          ? frontmatter.tags.map((tag: unknown) => String(tag))
          : []
      }))
      .sort((a, b) => +new Date(b.date) - +new Date(a.date))
  }
})

function formatDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value))
  return date.toISOString().slice(0, 10)
}

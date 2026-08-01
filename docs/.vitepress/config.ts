import { yadawFontsOptions } from "@yadaw/ui/fonts"
import Unfonts from "unplugin-fonts/vite"
import { defineConfig, type HeadConfig, type MarkdownOptions, type PageData } from "vitepress"

const markdown: MarkdownOptions = {
  config(md) {
    const defaultFence = md.renderer.rules.fence
    md.renderer.rules.fence = (tokens, idx, options, env, self) => {
      const token = tokens[idx]
      if (token !== undefined && token.info.trim() === "mermaid") {
        return `<ClientOnly><MermaidDiagram code="${encodeURIComponent(token.content)}" /></ClientOnly>\n`
      }
      if (defaultFence !== undefined) {
        return defaultFence(tokens, idx, options, env, self)
      }
      return self.renderToken(tokens, idx, options)
    }
  }
}

const docsRoot = "https://yadaw.minori.live"
const ogImage = `${docsRoot}/og.png`
const defaultDescriptionEn = "A free and open-source digital audio workstation."
const defaultDescriptionZh = "一款自由开源的数字音频工作站。"

function pageUrl(relativePath: string): string {
  const path = relativePath.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "")
  return `${docsRoot}/${path}`.replace(/\/$/, "") || docsRoot
}

function pageTitle(pageData: PageData): string {
  const title = pageData.title || "YADAW"
  const titleTemplate: unknown = pageData.frontmatter.titleTemplate
  if (titleTemplate === false) {
    return title
  }

  const template = typeof titleTemplate === "string" ? titleTemplate : ":title · YADAW"
  if (template.includes(":title")) {
    return template.replace(/:title/g, title)
  }

  return `${title} · YADAW`
}

function pageDescription(pageData: PageData): string {
  const frontmatterDescription: unknown = pageData.frontmatter.description
  const fromPage =
    pageData.description ||
    (typeof frontmatterDescription === "string" ? frontmatterDescription : "")
  if (fromPage.length > 0) {
    return fromPage
  }

  return pageData.relativePath === "zh" || pageData.relativePath.startsWith("zh/")
    ? defaultDescriptionZh
    : defaultDescriptionEn
}

function ensurePageHead(pageData: PageData): HeadConfig[] {
  const existing: unknown = pageData.frontmatter.head
  const head: HeadConfig[] = Array.isArray(existing) ? (existing as HeadConfig[]) : []
  pageData.frontmatter.head = head
  return head
}

function isBlogArticle(relativePath: string): boolean {
  return /^blog\/(?!index\.md$).+\.md$/.test(relativePath)
}

export default defineConfig({
  title: "YADAW",
  titleTemplate: ":title · YADAW",
  base: "/",
  srcDir: "content",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  sitemap: {
    hostname: docsRoot
  },
  markdown,
  vite: {
    // unplugin-fonts resolves against workspace Vite 8; VitePress pins Vite 5.
    plugins: [Unfonts(yadawFontsOptions) as never]
  },
  head: [
    ["link", { rel: "icon", href: "/logo.svg", type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#101010" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:site_name", content: "YADAW" }],
    ["meta", { property: "og:image", content: ogImage }],
    ["meta", { property: "og:image:width", content: "1200" }],
    ["meta", { property: "og:image:height", content: "630" }],
    ["meta", { name: "twitter:card", content: "summary_large_image" }],
    ["meta", { name: "twitter:image", content: ogImage }]
  ],
  transformPageData(pageData) {
    const title = pageTitle(pageData)
    const description = pageDescription(pageData)
    const url = pageUrl(pageData.relativePath)
    const head = ensurePageHead(pageData)

    head.push(
      ["link", { rel: "canonical", href: url }],
      ["meta", { property: "og:title", content: title }],
      ["meta", { property: "og:description", content: description }],
      ["meta", { property: "og:url", content: url }],
      ["meta", { name: "twitter:title", content: title }],
      ["meta", { name: "twitter:description", content: description }]
    )

    if (isBlogArticle(pageData.relativePath)) {
      head.push(["meta", { property: "og:type", content: "article" }])
    }
  },
  locales: {
    root: {
      label: "English",
      lang: "en-US",
      description: defaultDescriptionEn,
      themeConfig: {
        nav: [
          { text: "Manual", link: "/manual/" },
          { text: "Blog", link: "/blog/" },
          { text: "Releases", link: "https://github.com/dsh0416/yadaw/releases" }
        ],
        sidebar: {
          "/blog/": [
            {
              text: "Development log",
              items: [{ text: "All posts", link: "/blog/" }]
            }
          ],
          "/manual/": [
            {
              text: "Start here",
              items: [
                { text: "Welcome to YADAW", link: "/manual/" },
                { text: "Install YADAW", link: "/manual/install" },
                { text: "Your first project", link: "/manual/first-project" }
              ]
            },
            {
              text: "Create",
              items: [
                { text: "The studio workspace", link: "/manual/studio-workspace" },
                { text: "Tracks and clips", link: "/manual/tracks-and-clips" },
                { text: "Record audio", link: "/manual/recording" },
                { text: "MIDI and piano roll", link: "/manual/midi-and-piano-roll" }
              ]
            },
            {
              text: "Shape the sound",
              items: [
                { text: "Mixer and routing", link: "/manual/mixer-and-routing" },
                { text: "VST3 plug-ins", link: "/manual/plugins" }
              ]
            },
            {
              text: "Reference",
              items: [
                { text: "Settings and audio devices", link: "/manual/settings" },
                { text: "Keyboard shortcuts", link: "/manual/keyboard-shortcuts" },
                { text: "Troubleshooting", link: "/manual/troubleshooting" }
              ]
            }
          ]
        },
        editLink: {
          pattern: "https://github.com/dsh0416/yadaw/edit/main/docs/content/:path",
          text: "Improve this page"
        },
        outline: {
          level: [2, 3],
          label: "On this page"
        },
        docFooter: {
          prev: "Previous",
          next: "Next"
        },
        lastUpdated: {
          text: "Updated"
        },
        footer: {
          message: "Free software, released under GPL-3.0.",
          copyright: "YADAW contributors"
        }
      }
    },
    zh: {
      label: "简体中文",
      lang: "zh-CN",
      link: "/zh/",
      description: defaultDescriptionZh,
      themeConfig: {
        nav: [
          { text: "手册", link: "/zh/manual/" },
          { text: "博客", link: "/blog/" },
          { text: "下载", link: "https://github.com/dsh0416/yadaw/releases" }
        ],
        sidebar: {
          "/zh/manual/": [
            {
              text: "从这里开始",
              items: [
                { text: "欢迎使用 YADAW", link: "/zh/manual/" },
                { text: "安装 YADAW", link: "/zh/manual/install" },
                { text: "第一个工程", link: "/zh/manual/first-project" }
              ]
            },
            {
              text: "创作",
              items: [
                { text: "工作室界面", link: "/zh/manual/studio-workspace" },
                { text: "轨道与片段", link: "/zh/manual/tracks-and-clips" },
                { text: "录制音频", link: "/zh/manual/recording" },
                { text: "MIDI 与钢琴卷帘", link: "/zh/manual/midi-and-piano-roll" }
              ]
            },
            {
              text: "塑造声音",
              items: [
                { text: "混音台与路由", link: "/zh/manual/mixer-and-routing" },
                { text: "VST3 插件", link: "/zh/manual/plugins" }
              ]
            },
            {
              text: "参考",
              items: [
                { text: "设置与音频设备", link: "/zh/manual/settings" },
                { text: "键盘快捷键", link: "/zh/manual/keyboard-shortcuts" },
                { text: "故障排除", link: "/zh/manual/troubleshooting" }
              ]
            }
          ]
        },
        editLink: {
          pattern: "https://github.com/dsh0416/yadaw/edit/main/docs/content/:path",
          text: "改进此页"
        },
        outline: {
          level: [2, 3],
          label: "页面导航"
        },
        docFooter: {
          prev: "上一页",
          next: "下一页"
        },
        lastUpdated: {
          text: "最后更新于"
        },
        footer: {
          message: "以 GPL-3.0 发布的自由软件。",
          copyright: "YADAW 贡献者"
        },
        returnToTopLabel: "回到顶部",
        sidebarMenuLabel: "菜单",
        darkModeSwitchLabel: "主题",
        lightModeSwitchTitle: "切换到浅色模式",
        darkModeSwitchTitle: "切换到深色模式",
        skipToContentLabel: "跳转到内容",
        langMenuLabel: "更改语言",
        notFound: {
          title: "页面未找到",
          quote: "此页面可能已被移动或删除。",
          linkLabel: "前往首页",
          linkText: "返回首页"
        }
      }
    }
  },
  themeConfig: {
    logo: {
      src: "/logo.svg",
      alt: "YADAW"
    },
    search: {
      provider: "local",
      options: {
        locales: {
          zh: {
            translations: {
              button: {
                buttonText: "搜索文档",
                buttonAriaLabel: "搜索文档"
              },
              modal: {
                noResultsText: "无法找到相关结果",
                resetButtonTitle: "清除查询条件",
                footer: {
                  selectText: "选择",
                  navigateText: "切换",
                  closeText: "关闭"
                }
              }
            }
          }
        }
      }
    },
    socialLinks: [{ icon: "github", link: "https://github.com/dsh0416/yadaw" }]
  }
})

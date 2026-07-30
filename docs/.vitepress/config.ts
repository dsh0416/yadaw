import { defineConfig } from "vitepress"

const base = process.env.YADAW_DOCS_BASE ?? "/"

export default defineConfig({
  title: "YADAW",
  titleTemplate: ":title · YADAW",
  description: "A free and open-source digital audio workstation.",
  lang: "en-US",
  base,
  srcDir: "content",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "dark",
  head: [
    ["link", { rel: "icon", href: `${base}logo.svg`, type: "image/svg+xml" }],
    ["meta", { name: "theme-color", content: "#101010" }],
    ["meta", { property: "og:type", content: "website" }],
    ["meta", { property: "og:title", content: "YADAW" }],
    [
      "meta",
      {
        property: "og:description",
        content: "A free and open-source digital audio workstation."
      }
    ]
  ],
  themeConfig: {
    logo: {
      src: "/logo.svg",
      alt: "YADAW"
    },
    nav: [
      { text: "Manual", link: "/manual/" },
      { text: "Releases", link: "https://github.com/dsh0416/yadaw/releases" }
    ],
    sidebar: {
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
    search: {
      provider: "local"
    },
    socialLinks: [{ icon: "github", link: "https://github.com/dsh0416/yadaw" }],
    editLink: {
      pattern: "https://github.com/dsh0416/yadaw/edit/main/docs/content/:path",
      text: "Improve this page"
    },
    footer: {
      message: "Free software, released under GPL-3.0.",
      copyright: "YADAW contributors"
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
    }
  }
})

import { computed, type ComputedRef } from "vue"
import { useData } from "vitepress"

export interface CapabilityCopy {
  index: string
  title: string
  body: string
}

export interface HomeCopy {
  heroEyebrow: string
  heroTitleTop: string
  heroTitleAccent: string
  heroLead: string
  openManual: string
  getRelease: string
  noticeStrong: string
  noticeRest: string
  captions: [string, string, string]
  sessionAriaLabel: string
  manifestoLabel: string
  manifestoStatement: string
  capabilitiesLabel: string
  capabilitiesTitle: string
  capabilities: [CapabilityCopy, CapabilityCopy, CapabilityCopy]
  principlesLabel: string
  principlesTitleTop: string
  principlesTitleBottom: string
  principles: [string, string, string, string]
  ctaLabel: string
  ctaTitle: string
  ctaButton: string
}

const en: HomeCopy = {
  heroEyebrow: "Yet Another Digital Audio Workstation",
  heroTitleTop: "Make sound,",
  heroTitleAccent: "of your own.",
  heroLead:
    "A free, open-source workspace for recording, arranging, and mixing music on Windows, macOS, and Linux.",
  openManual: "Open the manual",
  getRelease: "Get a release",
  noticeStrong: "Experimental software.",
  noticeRest: "Explore freely, but keep backups of important work.",
  captions: ["Arrangement", "Native audio", "VST3"],
  sessionAriaLabel: "A stylized YADAW arrangement with audio and MIDI tracks",
  manifestoLabel: "Built for the work between idea and mix",
  manifestoStatement:
    "YADAW keeps the timeline, mixer, instruments, and project archive in one inspectable workspace—without an account or subscription between you and your music.",
  capabilitiesLabel: "What works today",
  capabilitiesTitle: "A practical foundation for real sessions.",
  capabilities: [
    {
      index: "REC",
      title: "Capture without losing the take.",
      body: "Record audio through the native engine. In-progress recordings stay recoverable in swap until they are committed to the project archive."
    },
    {
      index: "MIDI",
      title: "Arrange notes beside audio.",
      body: "Import MIDI, place clips on the timeline, and shape notes in the docked piano roll without leaving the arrangement."
    },
    {
      index: "MIX",
      title: "Route, meter, and process.",
      body: "Balance channels, create sends and buses, and host VST3 effects in a supervised audio process designed to contain plug-in failures."
    }
  ],
  principlesLabel: "The project is yours",
  principlesTitleTop: "No cloud gate.",
  principlesTitleBottom: "No opaque service.",
  principles: [
    "Free software under GPL-3.0",
    "Self-contained project archives",
    "Cross-platform by design",
    "Developed in the open"
  ],
  ctaLabel: "Start with the signal path",
  ctaTitle: "Set up your audio device, create a project, and press play.",
  ctaButton: "Make your first project →"
}

const zh: HomeCopy = {
  heroEyebrow: "Yet Another Digital Audio Workstation",
  heroTitleTop: "创造声音，",
  heroTitleAccent: "由你做主。",
  heroLead: "一个自由、开源的工作区，在 Windows、macOS 与 Linux 上录音、编排与混音。",
  openManual: "打开手册",
  getRelease: "获取发布版本",
  noticeStrong: "实验性软件。",
  noticeRest: "欢迎自由探索，但请备份好重要的工作。",
  captions: ["编排", "原生音频", "VST3"],
  sessionAriaLabel: "YADAW 编排界面的风格化示意，包含音频与 MIDI 轨道",
  manifestoLabel: "为从灵感到混音之间的每一步而生",
  manifestoStatement:
    "YADAW 将时间线、混音台、乐器与工程归档放进同一个可检视的工作区——你与音乐之间，没有账号，也没有订阅。",
  capabilitiesLabel: "今天就能用",
  capabilitiesTitle: "为真实会话打造的实用基础。",
  capabilities: [
    {
      index: "REC",
      title: "录制，不丢任何一遍。",
      body: "通过原生引擎录制音频。未完成的录音在写入工程归档前，始终可以从交换目录中恢复。"
    },
    {
      index: "MIDI",
      title: "让音符与音频并肩编排。",
      body: "导入 MIDI，将片段放上时间线，在停靠的钢琴卷帘中雕琢音符，全程无需离开编排界面。"
    },
    {
      index: "MIX",
      title: "路由、电平与处理。",
      body: "平衡通道，创建发送与总线，并在受监督的音频进程中托管 VST3 效果，将插件故障隔离在外。"
    }
  ],
  principlesLabel: "工程属于你",
  principlesTitleTop: "没有云端门槛。",
  principlesTitleBottom: "没有黑箱服务。",
  principles: ["基于 GPL-3.0 的自由软件", "自包含的工程归档", "天生的跨平台设计", "完全公开的开发"],
  ctaLabel: "从信号路径开始",
  ctaTitle: "设置好音频设备，创建一个工程，然后按下播放。",
  ctaButton: "创建你的第一个工程 →"
}

const homeCopy: Record<string, HomeCopy> = {
  root: en,
  zh
}

export function useHomeCopy(): ComputedRef<HomeCopy> {
  const { localeIndex } = useData()
  return computed(() => homeCopy[localeIndex.value] ?? en)
}

export function useLocalePrefix(): ComputedRef<string> {
  const { localeIndex } = useData()
  return computed(() => (localeIndex.value === "root" ? "" : `/${localeIndex.value}`))
}

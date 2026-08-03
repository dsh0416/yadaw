<script setup lang="ts">
import { UiSegmentedControl } from "@yadaw/ui"
import type { UiSegmentedOption } from "@yadaw/ui"
import { useData } from "vitepress"
import { computed, shallowRef, watch } from "vue"
import AudioBackendNode from "./AudioBackendNode.vue"
import type { AudioBackendStatus } from "./AudioBackendNode.vue"
import ManualDemoFrame from "./ManualDemoFrame.vue"

type OperatingSystem = "windows" | "macos" | "linux"

interface AudioBackendEntry {
  id: string
  name: string
  systems: readonly OperatingSystem[]
  status: AudioBackendStatus
  detail: {
    en: string
    zh: string
  }
}

interface AudioBackendFigureCopy {
  eyebrow: string
  title: string
  description: string
  osLabel: string
  supported: string
  planned: string
  host: string
  currentSummary: string
  plannedSummary: string
  currentDetail: string
  plannedDetail: string
}

const backendEntries: readonly AudioBackendEntry[] = [
  {
    id: "wasapi",
    name: "WASAPI",
    systems: ["windows"],
    status: "supported",
    detail: {
      en: "The standard Windows audio path for built-in devices and everyday playback.",
      zh: "Windows 的标准音频路径，适合内建设备与日常播放。"
    }
  },
  {
    id: "asio",
    name: "ASIO®",
    systems: ["windows"],
    status: "supported",
    detail: {
      en: "Uses a manufacturer's 64-bit ASIO driver; input and output share that driver.",
      zh: "使用设备厂商的 64 位 ASIO 驱动；输入与输出共用同一个驱动。"
    }
  },
  {
    id: "coreaudio",
    name: "CoreAudio",
    systems: ["macos"],
    status: "supported",
    detail: {
      en: "The native macOS audio path. Recording also requires microphone permission.",
      zh: "macOS 原生音频路径；录音时还需要授予麦克风权限。"
    }
  },
  {
    id: "alsa",
    name: "ALSA",
    systems: ["linux"],
    status: "supported",
    detail: {
      en: "The current native Linux backend. Device access follows the system ALSA configuration.",
      zh: "当前的 Linux 原生后端；设备访问取决于系统 ALSA 配置。"
    }
  },
  {
    id: "jack",
    name: "JACK",
    systems: ["windows", "macos", "linux"],
    status: "planned",
    detail: {
      en: "A dedicated JACK backend is planned for Windows, macOS, and Linux.",
      zh: "Windows、macOS 与 Linux 均计划增加独立的 JACK 后端。"
    }
  },
  {
    id: "pipewire",
    name: "PipeWire",
    systems: ["linux"],
    status: "planned",
    detail: {
      en: "Native PipeWire integration is planned for a future version.",
      zh: "未来版本计划增加原生 PipeWire 集成。"
    }
  },
  {
    id: "pulseaudio",
    name: "PulseAudio",
    systems: ["linux"],
    status: "planned",
    detail: {
      en: "A dedicated PulseAudio backend is planned for a future version.",
      zh: "未来版本计划增加独立的 PulseAudio 后端。"
    }
  },
  {
    id: "mock",
    name: "Mock",
    systems: ["windows", "macos", "linux"],
    status: "supported",
    detail: {
      en: "Runs the complete engine without hardware: capture is silent and playback is discarded.",
      zh: "无需硬件即可运行完整引擎：捕获为静音，播放会被丢弃。"
    }
  }
]

const copyByLocale: Record<"en" | "zh", AudioBackendFigureCopy> = {
  en: {
    eyebrow: "Interactive reference",
    title: "Trace the host path",
    description:
      "Choose an operating system, then inspect the backends connected to its audio host.",
    osLabel: "Operating system",
    supported: "Current",
    planned: "Planned",
    host: "Audio host",
    currentSummary: "included now",
    plannedSummary: "on the roadmap",
    currentDetail: "This backend is included in current builds.",
    plannedDetail: "This backend is planned and does not appear in the application yet."
  },
  zh: {
    eyebrow: "交互参考",
    title: "查看音频宿主路径",
    description: "选择操作系统，然后检查连接到其音频宿主的后端。",
    osLabel: "操作系统",
    supported: "当前支持",
    planned: "未来计划",
    host: "音频宿主",
    currentSummary: "当前已包含",
    plannedSummary: "已进入计划",
    currentDetail: "当前构建已经包含这个后端。",
    plannedDetail: "这个后端仍在计划中，目前不会出现在应用里。"
  }
}

const osOptions: readonly UiSegmentedOption[] = [
  { label: "Windows", value: "windows" },
  { label: "macOS", value: "macos" },
  { label: "Linux", value: "linux" }
]

const { localeIndex } = useData()
const locale = computed<"en" | "zh">(() => (localeIndex.value === "zh" ? "zh" : "en"))
const copy = computed(() => copyByLocale[locale.value])
const selectedOs = shallowRef<OperatingSystem>("windows")
const visibleBackends = computed(() =>
  backendEntries.filter((entry) => entry.systems.includes(selectedOs.value))
)
const selectedBackendId = shallowRef(visibleBackends.value[0]?.id ?? "")
const selectedBackend = computed(
  () => visibleBackends.value.find((entry) => entry.id === selectedBackendId.value) ?? null
)
const supportedCount = computed(
  () => visibleBackends.value.filter((entry) => entry.status === "supported").length
)
const plannedCount = computed(
  () => visibleBackends.value.filter((entry) => entry.status === "planned").length
)

watch(selectedOs, () => {
  selectedBackendId.value = visibleBackends.value[0]?.id ?? ""
})
</script>

<template>
  <ManualDemoFrame :eyebrow="copy.eyebrow" :title="copy.title" :description="copy.description">
    <template #controls>
      <UiSegmentedControl
        v-model="selectedOs"
        class="backend-figure__os-selector"
        :label="copy.osLabel"
        :options="osOptions"
        size="sm"
      />
    </template>

    <div class="backend-figure__host-rail" aria-hidden="true">
      <span class="backend-figure__host-label">{{ copy.host }} / {{ selectedOs }}</span>
      <i />
      <span>{{ supportedCount }} {{ copy.currentSummary }}</span>
      <span v-if="plannedCount > 0">{{ plannedCount }} {{ copy.plannedSummary }}</span>
    </div>

    <div class="backend-figure__nodes">
      <AudioBackendNode
        v-for="backend in visibleBackends"
        :key="backend.id"
        :name="backend.name"
        :status="backend.status"
        :status-label="backend.status === 'supported' ? copy.supported : copy.planned"
        :selected="backend.id === selectedBackendId"
        @select="selectedBackendId = backend.id"
      />
    </div>

    <template #footer>
      <div v-if="selectedBackend" class="backend-figure__detail" aria-live="polite">
        <span :data-status="selectedBackend.status" aria-hidden="true" />
        <div>
          <strong>{{ selectedBackend.name }}</strong>
          <p>{{ selectedBackend.detail[locale] }}</p>
        </div>
        <small>
          {{ selectedBackend.status === "supported" ? copy.currentDetail : copy.plannedDetail }}
        </small>
      </div>
    </template>
  </ManualDemoFrame>
</template>

<style scoped>
.backend-figure__os-selector {
  max-width: 100%;
}

.backend-figure__host-rail {
  display: grid;
  grid-template-columns: auto minmax(1rem, 1fr) auto auto;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 1rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.6rem;
  font-weight: 650;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.backend-figure__host-label {
  color: var(--yadaw-cyan);
}

.backend-figure__host-rail i {
  height: 1px;
  background: var(--yadaw-cyan-dark);
  box-shadow: 0 0 8px color-mix(in srgb, var(--yadaw-cyan) 42%, transparent);
}

.backend-figure__nodes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.backend-figure__detail {
  display: grid;
  grid-template-columns: 0.65rem minmax(0, 1fr) minmax(9rem, auto);
  align-items: start;
  gap: 0.75rem;
}

.backend-figure__detail > span {
  width: 0.5rem;
  height: 0.5rem;
  margin-top: 0.32rem;
  border-radius: 50%;
  background: var(--yadaw-meter);
  box-shadow: 0 0 7px color-mix(in srgb, var(--yadaw-meter) 65%, transparent);
}

.backend-figure__detail > span[data-status="planned"] {
  background: var(--yadaw-warning);
  box-shadow: 0 0 7px color-mix(in srgb, var(--yadaw-warning) 65%, transparent);
}

.backend-figure__detail strong {
  display: block;
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.75rem;
}

.backend-figure__detail p,
.backend-figure__detail small {
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.72rem;
  line-height: 1.5;
}

.backend-figure__detail p {
  margin-top: 0.2rem;
}

.backend-figure__detail small {
  color: var(--vp-c-text-3);
  text-align: right;
}

@media (max-width: 620px) {
  .backend-figure__host-rail {
    grid-template-columns: auto minmax(1rem, 1fr) auto;
  }

  .backend-figure__host-rail span:last-child:not(:first-child) {
    display: none;
  }

  .backend-figure__nodes {
    grid-template-columns: 1fr;
  }

  .backend-figure__detail {
    grid-template-columns: 0.65rem minmax(0, 1fr);
  }

  .backend-figure__detail small {
    grid-column: 2;
    text-align: left;
  }
}

@media (max-width: 420px) {
  .backend-figure__os-selector {
    width: 100%;
  }
}
</style>

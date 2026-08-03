<script setup lang="ts">
import { useData } from "vitepress"
import { computed, shallowRef } from "vue"
import type {
  MixerChannelPatch,
  MixerChannelState,
  MixerParameterPreview,
  MixerRouteTarget,
  MixerSendPatch,
  MixerSendState,
  MixerSendTap
} from "@heron/contracts"
import ManualDemoFrame from "./ManualDemoFrame.vue"
import ManualMixerChannelStrip from "./ManualMixerChannelStrip.vue"
import RoutingPath from "./RoutingPath.vue"
import type { RoutingPathNode } from "./routing-path"

type Locale = "en" | "zh"

interface RoutingCopy {
  eyebrow: string
  title: string
  description: string
  realStrip: string
  routeMap: string
  hint: string
  liveState: string
  mainRoute: string
  sendRoute: string
  noRoute: string
  noSend: string
  disabledSend: string
  source: string
  bus: string
  aux: string
  output: string
  finalControl: string
  audioTrack: string
  outputName: string
  masterName: string
  reverbName: string
  musicBusName: string
  directDetail: string
  busDetail: (bus: string, aux: string) => string
  sendDetail: (level: string, tap: string, target: string) => string
  mainFooter: (target: string) => string
  sendFooter: (level: string, tap: string, target: string) => string
  noSendFooter: string
  targetLabel: string
  tapLabel: string
  levelLabel: string
}

const copyByLocale: Record<Locale, RoutingCopy> = {
  en: {
    eyebrow: "Live mixer fixture",
    title: "Route from the real channel strip",
    description:
      "This is the same mixer strip used by Heron. Change its Output, open the Send row, or move the fader and pan control; the route map reads that in-memory state.",
    realStrip: "Real mixer strip",
    routeMap: "Derived route map",
    hint: "Try Output, the BUS 1 send row, Pan, or the fader. Nothing here touches audio hardware or a project file.",
    liveState: "Live state",
    mainRoute: "Main route",
    sendRoute: "Send copy",
    noRoute: "No main destination",
    noSend: "No send slot — add one from the empty Send row",
    disabledSend: "Send disabled — the route remains configured but creates no copy",
    source: "Track signal",
    bus: "Bus slot",
    aux: "Aux channel",
    output: "Output channel",
    finalControl: "Final control",
    audioTrack: "Audio 01",
    outputName: "Output 1–2",
    masterName: "Master",
    reverbName: "Reverb",
    musicBusName: "Music Bus",
    directDetail: "The channel targets Output 1–2 directly.",
    busDetail: (bus, aux) => `The channel enters ${bus}, which the ${aux} aux receives.`,
    sendDetail: (level, tap, target) => `${level} ${tap} copy to ${target}`,
    mainFooter: (target) => `The main signal has one destination: ${target}.`,
    sendFooter: (level, tap, target) =>
      `A parallel ${level} ${tap} copy goes to ${target}; it does not replace the main route.`,
    noSendFooter: "No parallel send copy is active.",
    targetLabel: "Target",
    tapLabel: "Tap",
    levelLabel: "Level"
  },
  zh: {
    eyebrow: "实时混音台样例",
    title: "直接从真实通道条搭建路由",
    description:
      "这里使用的就是 Heron 的 Mixer Strip。改变“输出”、打开“BUS 1”发送行，或移动推子和声像；右侧路由图会读取同一份内存状态。",
    realStrip: "真实 Mixer Strip",
    routeMap: "派生路由图",
    hint: "可以尝试输出、BUS 1 发送行、声像或推子。这里不会访问音频硬件，也不会修改工程文件。",
    liveState: "实时状态",
    mainRoute: "主路由",
    sendRoute: "发送副本",
    noRoute: "没有主输出目标",
    noSend: "没有发送槽位——可以从空的发送行添加",
    disabledSend: "发送已禁用——路由配置仍保留，但不会创建副本",
    source: "轨道信号",
    bus: "总线槽位",
    aux: "辅助通道",
    output: "输出通道",
    finalControl: "最终控制",
    audioTrack: "音频 01",
    outputName: "输出 1–2",
    masterName: "主输出",
    reverbName: "混响",
    musicBusName: "音乐总线",
    directDetail: "通道直接以输出 1–2 为目标。",
    busDetail: (bus, aux) => `通道进入 ${bus}，再由${aux}辅助通道接收。`,
    sendDetail: (level, tap, target) => `以 ${level} 从${tap}复制到 ${target}`,
    mainFooter: (target) => `主信号只有一个目标：${target}。`,
    sendFooter: (level, tap, target) =>
      `一份 ${level} 的${tap}副本并行送往 ${target}；它不会替代主路由。`,
    noSendFooter: "当前没有启用并行发送副本。",
    targetLabel: "目标",
    tapLabel: "拾取点",
    levelLabel: "电平"
  }
}

const OUTPUT_ID = "manual-output-1-2"

const { localeIndex } = useData()
const locale = computed<Locale>(() => (localeIndex.value === "zh" ? "zh" : "en"))
const copy = computed(() => copyByLocale[locale.value])

const channel = shallowRef<MixerChannelState>({
  id: "manual-audio-01",
  kind: "audio",
  systemRole: null,
  name: "Audio 01",
  color: "#72c3c7",
  sortOrder: 0,
  inputSource: "hardware",
  inputFormat: "stereo",
  gainDb: -3,
  pan: 0,
  muted: false,
  soloed: false,
  outputChannelId: OUTPUT_ID,
  outputBus: null,
  recordArmed: false,
  inputMonitoring: false,
  inputChannels: [1, 2],
  hardwareOutputChannels: []
})

const sends = shallowRef<MixerSendState[]>([
  {
    id: "manual-reverb-send",
    sourceChannelId: channel.value.id,
    targetChannelId: null,
    targetBus: 1,
    sortOrder: 0,
    enabled: true,
    tap: "post",
    levelDb: -12
  }
])

const activeSend = computed(() => sends.value[0] ?? null)
const mainTarget = computed<MixerRouteTarget | null>(() => {
  if (channel.value.outputChannelId) {
    return { kind: "output", channelId: channel.value.outputChannelId }
  }
  if (channel.value.outputBus != null) return { kind: "bus", bus: channel.value.outputBus }
  return null
})
const sendTarget = computed<MixerRouteTarget | null>(() => {
  const send = activeSend.value
  if (!send) return null
  if (send.targetChannelId) return { kind: "output", channelId: send.targetChannelId }
  if (send.targetBus != null) return { kind: "bus", bus: send.targetBus }
  return null
})

function formattedDb(value: number): string {
  if (value <= -90) return "−∞ dB"
  const prefix = value > 0 ? "+" : value < 0 ? "−" : ""
  return `${prefix}${Math.abs(value).toFixed(1)} dB`
}

function tapName(tap: MixerSendTap): string {
  const names: Record<Locale, Record<MixerSendTap, string>> = {
    en: { pre: "pre-fader", post: "post-fader", "post-pan": "post-pan" },
    zh: { pre: "推子前", post: "推子后", "post-pan": "声像后" }
  }
  return names[locale.value][tap]
}

function busNames(bus: number): { bus: string; aux: string } {
  if (bus === 1) return { bus: "BUS 1", aux: copy.value.reverbName }
  if (bus === 2) return { bus: "BUS 2", aux: copy.value.musicBusName }
  return { bus: `BUS ${bus}`, aux: locale.value === "zh" ? "辅助通道" : "Aux" }
}

function targetName(target: MixerRouteTarget | null): string {
  if (!target) return copy.value.noRoute
  if (target.kind === "output") return copy.value.outputName
  const names = busNames(target.bus)
  return `${names.bus} → ${names.aux}`
}

function routeNodes(target: MixerRouteTarget | null, prefix: string): readonly RoutingPathNode[] {
  const nodes: RoutingPathNode[] = [
    { id: `${prefix}-source`, eyebrow: copy.value.source, label: copy.value.audioTrack }
  ]
  if (!target) return nodes
  if (target.kind === "bus") {
    const names = busNames(target.bus)
    nodes.push(
      { id: `${prefix}-bus`, eyebrow: copy.value.bus, label: names.bus },
      { id: `${prefix}-aux`, eyebrow: copy.value.aux, label: names.aux }
    )
  }
  nodes.push(
    { id: `${prefix}-output`, eyebrow: copy.value.output, label: copy.value.outputName },
    { id: `${prefix}-master`, eyebrow: copy.value.finalControl, label: copy.value.masterName }
  )
  return nodes
}

const mainNodes = computed(() => routeNodes(mainTarget.value, "main"))
const sendNodes = computed(() => routeNodes(sendTarget.value, "send"))
const mainDetail = computed(() => {
  const target = mainTarget.value
  if (!target) return copy.value.noRoute
  if (target.kind === "output") return copy.value.directDetail
  const names = busNames(target.bus)
  return copy.value.busDetail(names.bus, names.aux)
})
const sendDetail = computed(() => {
  const send = activeSend.value
  if (!send) return copy.value.noSend
  if (!send.enabled) return copy.value.disabledSend
  return copy.value.sendDetail(
    formattedDb(send.levelDb),
    tapName(send.tap),
    targetName(sendTarget.value)
  )
})
const footerSummary = computed(() => {
  const main = copy.value.mainFooter(targetName(mainTarget.value))
  const send = activeSend.value
  if (!send?.enabled) return `${main} ${copy.value.noSendFooter}`
  return `${main} ${copy.value.sendFooter(
    formattedDb(send.levelDb),
    tapName(send.tap),
    targetName(sendTarget.value)
  )}`
})

function updateChannel(patch: MixerChannelPatch): void {
  channel.value = { ...channel.value, ...patch }
}

function updateSend(sendId: string, patch: MixerSendPatch): void {
  sends.value = sends.value.map((send) => (send.id === sendId ? { ...send, ...patch } : send))
}

function preview(previewValue: MixerParameterPreview): void {
  if (previewValue.target === "channel") {
    updateChannel({ [previewValue.parameter]: previewValue.value })
    return
  }
  if (previewValue.target === "send") {
    updateSend(previewValue.id, { levelDb: previewValue.value })
  }
}

function addSend(target: MixerRouteTarget): void {
  if (activeSend.value) return
  sends.value = [
    {
      id: "manual-send",
      sourceChannelId: channel.value.id,
      targetChannelId: target.kind === "output" ? target.channelId : null,
      targetBus: target.kind === "bus" ? target.bus : null,
      sortOrder: 0,
      enabled: true,
      tap: "post",
      levelDb: -12
    }
  ]
}

function deleteSend(sendId: string): void {
  sends.value = sends.value.filter((send) => send.id !== sendId)
}
</script>

<template>
  <ManualDemoFrame :eyebrow="copy.eyebrow" :title="copy.title" :description="copy.description">
    <div class="routing-playground__workbench">
      <section class="routing-playground__strip-bay" :aria-label="copy.realStrip">
        <header class="routing-playground__section-heading">
          <span>CH 01</span>
          <strong>{{ copy.realStrip }}</strong>
        </header>
        <ManualMixerChannelStrip
          :channel="channel"
          :sends="sends"
          @preview="preview"
          @update-channel="updateChannel"
          @update-send="updateSend"
          @add-send="addSend"
          @delete-send="deleteSend"
        />
        <p class="routing-playground__hint">{{ copy.hint }}</p>
      </section>

      <section class="routing-playground__map" :aria-label="copy.routeMap">
        <header class="routing-playground__section-heading">
          <span>GRAPH</span>
          <strong>{{ copy.routeMap }}</strong>
        </header>

        <div class="routing-playground__readout">
          <span>{{ copy.liveState }}</span>
          <dl>
            <div>
              <dt>{{ copy.targetLabel }}</dt>
              <dd>{{ targetName(mainTarget) }}</dd>
            </div>
            <div>
              <dt>{{ copy.tapLabel }}</dt>
              <dd>{{ activeSend ? tapName(activeSend.tap) : "—" }}</dd>
            </div>
            <div>
              <dt>{{ copy.levelLabel }}</dt>
              <dd>{{ activeSend ? formattedDb(activeSend.levelDb) : "—" }}</dd>
            </div>
          </dl>
        </div>

        <div class="routing-playground__paths">
          <RoutingPath
            :label="copy.mainRoute"
            :detail="mainDetail"
            :nodes="mainNodes"
            tone="main"
            :active="mainTarget !== null"
          />
          <RoutingPath
            :label="copy.sendRoute"
            :detail="sendDetail"
            :nodes="sendNodes"
            tone="send"
            :active="activeSend?.enabled === true && sendTarget !== null"
            :signal-strength="
              activeSend?.enabled ? Math.max(0.08, (activeSend.levelDb + 90) / 102) : 0
            "
          />
        </div>
      </section>
    </div>

    <template #footer>
      <p class="routing-playground__summary" aria-live="polite">
        <span aria-hidden="true">→</span>{{ footerSummary }}
      </p>
    </template>
  </ManualDemoFrame>
</template>

<style scoped>
.routing-playground__workbench {
  display: grid;
  grid-template-columns: 164px minmax(0, 1fr);
  align-items: start;
  gap: 1rem;
}

.routing-playground__strip-bay,
.routing-playground__map {
  min-width: 0;
}

.routing-playground__strip-bay {
  display: grid;
  justify-items: center;
  padding: 0.75rem 0.75rem 0.9rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--heron-cyan) 7%, transparent), transparent 38%),
    #242424;
  box-shadow:
    0 16px 32px rgb(0 0 0 / 20%),
    0 1px 0 rgb(255 255 255 / 5%) inset;
}

.routing-playground__section-heading {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.7rem;
  font-family: var(--vp-font-family-mono);
  line-height: 1.2;
}

.routing-playground__section-heading span {
  color: var(--heron-cyan);
  font-size: 0.56rem;
  font-weight: 750;
  letter-spacing: 0.1em;
}

.routing-playground__section-heading strong {
  color: var(--vp-c-text-2);
  font-size: 0.58rem;
  font-weight: 650;
}

.routing-playground__strip-bay .routing-playground__section-heading strong {
  color: #c9c9c9;
}

.routing-playground__hint {
  margin: 0.75rem 0 0;
  color: #a6a6a6;
  font-size: 0.62rem;
  line-height: 1.5;
}

.routing-playground__map {
  display: grid;
  gap: 0.75rem;
}

.routing-playground__readout {
  display: grid;
  gap: 0.55rem;
  padding: 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 7px;
  background: color-mix(in srgb, var(--vp-c-bg) 72%, transparent);
}

.routing-playground__readout > span {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.53rem;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
}

.routing-playground__readout dl {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr;
  gap: 0.5rem;
  margin: 0;
}

.routing-playground__readout dl div {
  min-width: 0;
}

.routing-playground__readout dt,
.routing-playground__readout dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.routing-playground__readout dt {
  color: var(--vp-c-text-3);
  font-size: 0.5rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.routing-playground__readout dd {
  margin-top: 0.25rem;
  color: var(--vp-c-text-1);
  font-size: 0.63rem;
  font-weight: 650;
}

.routing-playground__paths {
  display: grid;
  gap: 0.75rem;
}

.routing-playground__summary {
  display: flex;
  align-items: flex-start;
  gap: 0.65rem;
  margin: 0;
  color: var(--vp-c-text-2);
  font-size: 0.75rem;
  line-height: 1.55;
}

.routing-playground__summary span {
  flex: none;
  color: var(--heron-cyan);
  font-family: var(--vp-font-family-mono);
}

@media (max-width: 620px) {
  .routing-playground__workbench {
    grid-template-columns: 1fr;
  }

  .routing-playground__strip-bay {
    width: 100%;
  }

  .routing-playground__readout dl {
    grid-template-columns: 1fr;
  }
}
</style>

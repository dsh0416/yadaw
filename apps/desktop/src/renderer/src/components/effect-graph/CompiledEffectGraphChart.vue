<script setup lang="ts">
import { useMutationObserver, usePreferredReducedMotion, useResizeObserver } from "@vueuse/core"
import { onBeforeUnmount, onMounted, shallowRef, useTemplateRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import type { CompiledAudioGraphSnapshot } from "@yadaw/contracts"
import { layoutCompiledEffectGraph } from "./compiledEffectGraphLayout"

const props = defineProps<{
  snapshot: CompiledAudioGraphSnapshot
  resetToken: number
}>()

const { t } = useI18n()

const chartElement = useTemplateRef<HTMLDivElement>("chart")
const chart = shallowRef<import("echarts/core").ECharts | null>(null)
const preferredReducedMotion = usePreferredReducedMotion()
let disposed = false

function cssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "currentColor"
}

async function render(): Promise<void> {
  const element = chartElement.value
  if (!element || disposed) return
  const [{ init, use }, { GraphChart }, { LegendComponent, TooltipComponent }, { CanvasRenderer }] =
    await Promise.all([
      import("echarts/core"),
      import("echarts/charts"),
      import("echarts/components"),
      import("echarts/renderers")
    ])
  if (disposed || !chartElement.value) return
  use([GraphChart, LegendComponent, TooltipComponent, CanvasRenderer])
  chart.value?.dispose()
  chart.value = init(
    element,
    document.documentElement.dataset.theme === "dark" ? "dark" : undefined
  )

  const layout = layoutCompiledEffectGraph(props.snapshot)
  const orange = cssColor("--mixer-input")
  const cyan = cssColor("--signal-cyan")
  const purple = cssColor("--ui-domain-color-b894ff")
  const muted = cssColor("--text-muted")
  const surface = cssColor("--surface-2")
  const reducedMotion = preferredReducedMotion.value === "reduce"
  const nodeColor = (node: (typeof layout.nodes)[number]) => {
    if (node.pluginState === "bypassed" || node.pluginState === "unavailable") return muted
    if (node.kind === "effect") return orange
    if (node.kind === "pdc-delay") return purple
    if (node.kind === "width-adapter") return cyan
    return surface
  }

  const legendActiveEffect = t("effectGraph.chart.legend.activeEffect")
  const legendAudioRoute = t("effectGraph.chart.legend.audioRoute")
  const legendPdcLatency = t("effectGraph.chart.legend.pdcLatency")
  const legendBypassedUnavailable = t("effectGraph.chart.legend.bypassedUnavailable")

  chart.value.setOption({
    animation: !reducedMotion,
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      formatter: (params: { data?: { detail?: string } }) => params.data?.detail ?? ""
    },
    legend: [
      {
        data: [legendActiveEffect, legendAudioRoute, legendPdcLatency, legendBypassedUnavailable],
        textStyle: { color: cssColor("--text-secondary") }
      }
    ],
    series: [
      {
        type: "graph",
        layout: "none",
        roam: true,
        symbolSize: 54,
        edgeSymbol: ["none", "arrow"],
        edgeSymbolSize: 7,
        label: {
          show: true,
          position: "bottom",
          color: cssColor("--text-primary"),
          width: 150,
          overflow: "truncate",
          fontSize: 11
        },
        emphasis: { focus: "adjacency" },
        categories: [
          { name: legendActiveEffect, itemStyle: { color: orange } },
          { name: legendAudioRoute, itemStyle: { color: cyan } },
          { name: legendPdcLatency, itemStyle: { color: purple } },
          { name: legendBypassedUnavailable, itemStyle: { color: muted } }
        ],
        data: layout.nodes.map((node) => ({
          id: node.id,
          name: node.label,
          x: node.x,
          y: node.y,
          category:
            node.pluginState === "bypassed" || node.pluginState === "unavailable"
              ? 3
              : node.kind === "effect"
                ? 0
                : node.kind === "pdc-delay"
                  ? 2
                  : 1,
          symbol: node.kind === "width-adapter" ? "diamond" : "roundRect",
          itemStyle: {
            color: nodeColor(node),
            opacity: node.pluginState === "unavailable" ? 0.45 : 1,
            borderColor:
              node.pluginState === "bypassed" || node.pluginState === "unavailable"
                ? muted
                : node.kind === "pdc-delay"
                  ? purple
                  : cyan,
            borderType:
              node.pluginState === "bypassed" || node.pluginState === "unavailable"
                ? "dashed"
                : "solid",
            borderWidth:
              node.pluginState === "bypassed" || node.pluginState === "unavailable" ? 2 : 1
          },
          detail: [
            node.label,
            node.kind.replaceAll("-", " "),
            node.pluginState
              ? t("effectGraph.chart.tooltip.state", { state: node.pluginState })
              : "",
            node.latencySamples > 0
              ? t("effectGraph.chart.tooltip.latency", { samples: node.latencySamples })
              : "",
            t("effectGraph.chart.tooltip.signal", { width: node.signalWidth })
          ]
            .filter(Boolean)
            .join("<br>")
        })),
        links: layout.edges.map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          lineStyle: {
            color: edge.kind === "send-route" ? orange : cyan,
            type: edge.kind === "send-route" ? "dashed" : "solid",
            width: 1.5,
            opacity: 0.78,
            curveness: edge.kind === "send-route" ? 0.12 : 0
          }
        }))
      }
    ]
  })
}

watch(() => props.snapshot, render)
watch(
  () => props.resetToken,
  () => chart.value?.dispatchAction({ type: "restore" })
)

useResizeObserver(chartElement, () => chart.value?.resize())
useMutationObserver(document.documentElement, () => void render(), {
  attributes: true,
  attributeFilter: ["data-theme"]
})

onMounted(() => {
  void render()
})

onBeforeUnmount(() => {
  disposed = true
  chart.value?.dispose()
  chart.value = null
})
</script>

<template>
  <div
    ref="chart"
    class="compiled-effect-graph-chart"
    :aria-label="t('effectGraph.chart.ariaLabel')"
  />
</template>

<style scoped>
.compiled-effect-graph-chart {
  width: 100%;
  min-height: 520px;
  background:
    linear-gradient(color-mix(in srgb, var(--line) 30%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--line) 30%, transparent) 1px, transparent 1px),
    var(--surface-1);
  background-size: 22px 22px;
}
</style>

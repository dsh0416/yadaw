<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue"
import { useData } from "vitepress"

const props = defineProps<{
  code: string
}>()

const { isDark } = useData()
const container = ref<HTMLElement | null>(null)
let renderGeneration = 0

async function renderDiagram(): Promise<void> {
  const host = container.value
  if (host === null) {
    return
  }

  const generation = ++renderGeneration
  const source = decodeURIComponent(props.code)
  const mermaid = (await import("mermaid")).default

  if (generation !== renderGeneration) {
    return
  }

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: isDark.value ? "dark" : "neutral"
  })

  const id = `heron-mermaid-${generation}`
  const { svg } = await mermaid.render(id, source)

  if (generation !== renderGeneration || container.value === null) {
    return
  }

  container.value.innerHTML = svg
  await nextTick()
}

onMounted(() => {
  void renderDiagram()
})

watch([isDark, () => props.code], () => {
  void renderDiagram()
})
</script>

<template>
  <div ref="container" class="heron-mermaid" aria-label="Diagram" />
</template>

<style scoped>
.heron-mermaid {
  margin: 1.25rem 0;
  overflow-x: auto;
  text-align: center;
}

.heron-mermaid :deep(svg) {
  max-width: 100%;
  height: auto;
}
</style>

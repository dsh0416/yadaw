<script setup lang="ts">
import { computed } from "vue"
import { useData } from "vitepress"
import { VstCompatibleLogo } from "@yadaw/ui"

const { isDark, localeIndex } = useData()
const appearance = computed(() => (isDark.value ? "on-dark" : "on-light"))
const title = computed(() =>
  localeIndex.value === "zh" ? "VST® 3 兼容性" : "VST® 3 compatibility"
)
</script>

<template>
  <aside class="vst-trademark-notice" :aria-label="title">
    <VstCompatibleLogo :appearance="appearance" decorative />
    <div class="vst-trademark-copy">
      <p class="vst-trademark-title">{{ title }}</p>
      <p class="vst-trademark-statement">
        VST is a registered trademark of Steinberg Media Technologies GmbH.
      </p>
    </div>
  </aside>
</template>

<style scoped>
.vst-trademark-notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 20px;
  margin-top: 40px;
  padding: 18px 20px;
  border: 1px solid var(--vp-c-divider);
  border-left: 4px solid var(--yadaw-cyan);
  border-radius: 7px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
}

.vst-compatible-logo {
  --vst-compatible-logo-width: 18mm;
}

.vst-trademark-copy {
  display: grid;
  gap: 6px;
}

.vst-trademark-title,
.vst-trademark-statement {
  margin: 0;
}

.vst-trademark-title {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.vst-trademark-statement {
  color: var(--vp-c-text-2);
  font-size: 12px;
  line-height: 1.55;
}

@media (max-width: 480px) {
  .vst-trademark-notice {
    grid-template-columns: 1fr;
  }
}
</style>

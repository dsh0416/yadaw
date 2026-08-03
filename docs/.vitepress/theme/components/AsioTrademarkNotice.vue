<script setup lang="ts">
import { computed } from "vue"
import { useData } from "vitepress"
import { AsioCompatibleLogo } from "@heron/ui"

const { localeIndex } = useData()
const title = computed(() => (localeIndex.value === "zh" ? "ASIO® 兼容性" : "ASIO® compatibility"))
</script>

<template>
  <aside class="asio-trademark-notice" :aria-label="title">
    <div class="asio-logo-stage">
      <AsioCompatibleLogo decorative />
    </div>
    <div class="asio-trademark-copy">
      <p class="asio-trademark-title">{{ title }}</p>
      <p class="asio-trademark-statement">
        ASIO is a registered trademark of Steinberg Media Technologies GmbH.
      </p>
    </div>
  </aside>
</template>

<style scoped>
.asio-trademark-notice {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 20px;
  margin-top: var(--trademark-notice-margin-top, 40px);
  padding: 18px 20px;
  border: 1px solid var(--vp-c-divider);
  border-left: 4px solid var(--heron-cyan);
  border-radius: 7px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
}

.asio-logo-stage {
  padding: 8px 10px;
  border-radius: 4px;
  background: var(--vp-c-black);
}

.asio-compatible-logo {
  --asio-compatible-logo-width: var(--trademark-logo-width, 24mm);
}

.asio-trademark-copy {
  display: grid;
  gap: 6px;
}

.asio-trademark-title,
.asio-trademark-statement {
  margin: 0;
}

.asio-trademark-title {
  font-family: var(--vp-font-family-mono);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.asio-trademark-statement {
  color: var(--vp-c-text-2);
  font-size: 12px;
  line-height: 1.55;
}

@media (max-width: 480px) {
  .asio-trademark-notice {
    grid-template-columns: 1fr;
  }

  .asio-logo-stage {
    width: fit-content;
  }
}
</style>

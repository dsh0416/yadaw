<script setup lang="ts">
import { useI18n } from "vue-i18n"
import thirdPartyNotices from "../../../../../../../THIRD_PARTY_NOTICES.txt?raw"

const { t } = useI18n()
</script>

<template>
  <details class="third-party-notices">
    <summary>{{ t("about.thirdPartyNotices") }}</summary>
    <pre>{{ thirdPartyNotices }}</pre>
  </details>
</template>

<style scoped>
.third-party-notices {
  padding: var(--ui-space-4);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-md);
  color: var(--ui-color-text-subtle);
  background: var(--ui-color-canvas-subtle);
  font-size: var(--ui-font-size-xs);
}

.third-party-notices summary {
  color: var(--ui-color-text);
  font-family: var(--ui-type-family-data);
  cursor: pointer;
}

.third-party-notices pre {
  overflow: auto;
  max-height: 16rem;
  margin: var(--ui-space-3) 0 0;
  padding: var(--ui-space-3);
  border: 1px solid var(--ui-color-border);
  border-radius: var(--ui-radius-sm);
  color: var(--ui-color-text-muted);
  background: var(--ui-color-canvas);
  font: var(--ui-font-size-xs) / var(--ui-type-leading-normal) var(--ui-type-family-data);
  white-space: pre-wrap;
}
</style>

<script setup lang="ts">
import { UiProvider } from "@yadaw/ui"
import { useData } from "vitepress"
import { computed } from "vue"

defineProps<{
  eyebrow: string
  title: string
  description: string
}>()

const { localeIndex } = useData()
const locale = computed(() => (localeIndex.value === "zh" ? "zh-CN" : "en-US"))
</script>

<template>
  <UiProvider :locale="locale" :tooltip-delay="350" :tooltip-skip-delay="100">
    <figure class="manual-demo-frame">
      <figcaption class="manual-demo-frame__caption">
        <p class="manual-demo-frame__eyebrow"><span aria-hidden="true" />{{ eyebrow }}</p>
        <h3 class="manual-demo-frame__title">{{ title }}</h3>
        <p class="manual-demo-frame__description">{{ description }}</p>
      </figcaption>

      <div v-if="$slots.controls" class="manual-demo-frame__controls">
        <slot name="controls" />
      </div>

      <div class="manual-demo-frame__body">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="manual-demo-frame__footer">
        <slot name="footer" />
      </footer>
    </figure>
  </UiProvider>
</template>

<style scoped>
.manual-demo-frame {
  --ui-color-action: var(--yadaw-cyan);
  --ui-color-action-hover: var(--yadaw-cyan-light);
  --ui-color-action-pressed: var(--yadaw-cyan-dark);
  --ui-color-action-text: #071315;
  --ui-color-border: var(--vp-c-divider);
  --ui-color-border-strong: var(--vp-c-border);
  --ui-color-control-pressed: var(--vp-c-bg);
  --ui-color-control-hover: var(--vp-c-bg-elv);
  --ui-color-focus: var(--yadaw-cyan);
  --ui-color-selection: color-mix(in srgb, var(--yadaw-cyan) 16%, var(--vp-c-bg-soft));
  --ui-color-surface-hover: var(--vp-c-bg-elv);
  --ui-color-surface-raised: var(--vp-c-bg-soft);
  --ui-color-text: var(--vp-c-text-1);
  --ui-color-text-muted: var(--vp-c-text-2);
  --ui-control-sm: 2rem;
  --ui-ease-standard: cubic-bezier(0.2, 0, 0, 1);
  --ui-font-size-xs: 0.75rem;
  --ui-font-size-sm: 0.875rem;
  --ui-focus-ring: 0 0 0 3px color-mix(in srgb, var(--yadaw-cyan) 36%, transparent);
  --ui-motion-fast: 100ms;
  --ui-opacity-disabled: 0.55;
  --ui-radius-md: 0.5rem;
  --ui-shadow-highlight-inset: 0 1px 0 color-mix(in srgb, var(--vp-c-text-1) 14%, transparent) inset;
  --ui-space-1: 0.25rem;
  --ui-space-2: 0.5rem;
  --ui-space-3: 0.75rem;
  --ui-target-min: 1.5rem;
  --ui-type-leading-tight: 1.2;
  --ui-type-leading-normal: 1.5;
  --ui-type-weight-medium: 500;

  position: relative;
  margin: 1.5rem 0 2rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  box-shadow:
    0 18px 48px rgb(0 0 0 / 16%),
    0 1px 0 color-mix(in srgb, var(--vp-c-text-1) 6%, transparent) inset;
  overflow: hidden;
}

.manual-demo-frame__caption {
  padding: 1.25rem 1.25rem 1rem;
  border-bottom: 1px solid var(--vp-c-divider);
}

.manual-demo-frame__eyebrow {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  margin: 0 0 0.75rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.11em;
  line-height: 1.2;
  text-transform: uppercase;
}

.manual-demo-frame__eyebrow span {
  width: 1.75rem;
  height: 1px;
  background: var(--yadaw-cyan);
  box-shadow: 0 0 8px color-mix(in srgb, var(--yadaw-cyan) 58%, transparent);
}

.manual-demo-frame__title {
  margin: 0;
  border: 0;
  color: var(--vp-c-text-1);
  font-family: var(--yadaw-display);
  font-size: 1.6rem;
  font-weight: 650;
  letter-spacing: -0.025em;
  line-height: 1.1;
}

.manual-demo-frame__description {
  max-width: 42rem;
  margin: 0.55rem 0 0;
  color: var(--vp-c-text-2);
  font-size: 0.875rem;
  line-height: 1.55;
}

.manual-demo-frame__controls {
  display: flex;
  align-items: center;
  padding: 0.85rem 1.25rem;
  border-bottom: 1px solid var(--vp-c-divider);
  background: color-mix(in srgb, var(--vp-c-bg) 54%, transparent);
}

.manual-demo-frame__body {
  padding: 1.25rem;
}

.manual-demo-frame__footer {
  padding: 0.9rem 1.25rem 1rem;
  border-top: 1px solid var(--vp-c-divider);
  background: color-mix(in srgb, var(--vp-c-bg) 38%, transparent);
}

@media (max-width: 520px) {
  .manual-demo-frame__caption,
  .manual-demo-frame__body {
    padding: 1rem;
  }

  .manual-demo-frame__controls,
  .manual-demo-frame__footer {
    padding-right: 1rem;
    padding-left: 1rem;
  }
}
</style>

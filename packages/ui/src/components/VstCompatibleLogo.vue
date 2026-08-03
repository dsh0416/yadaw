<script setup lang="ts">
import { computed } from "vue"
import logoOnDark from "../assets/VST_Compatible_Logo_Steinberg.svg"
import logoOnLight from "../assets/VST_Compatible_Logo_Steinberg_negative.svg"

const props = withDefaults(
  defineProps<{
    appearance?: "on-dark" | "on-light"
    decorative?: boolean
  }>(),
  {
    appearance: "on-dark",
    decorative: false
  }
)

const source = computed(() => (props.appearance === "on-dark" ? logoOnDark : logoOnLight))
</script>

<template>
  <img
    class="vst-compatible-logo"
    :data-appearance="props.appearance"
    :src="source"
    :alt="props.decorative ? '' : 'VST Compatible'"
    :aria-hidden="props.decorative ? 'true' : undefined"
  />
</template>

<style scoped>
.vst-compatible-logo {
  display: block;
  width: var(--vst-compatible-logo-width, 16mm);
  min-width: 15mm;
  min-height: 10mm;
  max-width: 100%;
  height: auto;
  object-fit: contain;
}
</style>

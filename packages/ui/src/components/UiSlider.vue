<script setup lang="ts">
import { useAttrs } from "vue"

defineOptions({ inheritAttrs: false })

const model = defineModel<number>({ required: true })
const props = withDefaults(
  defineProps<{
    min?: number
    max?: number
    step?: number
    label: string
    valueText?: string
  }>(),
  {
    min: 0,
    max: 100,
    step: 1,
    valueText: undefined
  }
)
const attrs = useAttrs()
</script>

<template>
  <input
    v-bind="attrs"
    v-model.number="model"
    class="ui-slider"
    type="range"
    :min="props.min"
    :max="props.max"
    :step="props.step"
    :aria-label="props.label"
    :aria-valuetext="props.valueText"
  />
</template>

<style scoped>
.ui-slider {
  width: 100%;
  min-width: 4rem;
  height: var(--ui-target-min);
  margin: 0;
  accent-color: var(--ui-color-action);
  cursor: pointer;
}

.ui-slider:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>

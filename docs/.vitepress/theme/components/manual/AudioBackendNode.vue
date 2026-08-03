<script setup lang="ts">
export type AudioBackendStatus = "supported" | "planned"

const props = defineProps<{
  name: string
  status: AudioBackendStatus
  statusLabel: string
  selected: boolean
}>()

const emit = defineEmits<{
  select: []
}>()
</script>

<template>
  <button
    class="backend-node"
    :class="[`backend-node--${props.status}`, { 'backend-node--selected': props.selected }]"
    type="button"
    :aria-pressed="props.selected"
    @click="emit('select')"
  >
    <span class="backend-node__socket" aria-hidden="true"><i /></span>
    <strong class="backend-node__name">{{ props.name }}</strong>
    <span class="backend-node__status">{{ props.statusLabel }}</span>
    <span class="backend-node__arrow" aria-hidden="true">→</span>
  </button>
</template>

<style scoped>
.backend-node {
  --backend-signal: var(--heron-meter);

  position: relative;
  display: grid;
  width: 100%;
  min-height: 3.25rem;
  grid-template-columns: 1.25rem minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 0.65rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  color: var(--vp-c-text-1);
  background: color-mix(in srgb, var(--vp-c-bg-elv) 78%, transparent);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease,
    transform 120ms ease;
}

.backend-node--planned {
  --backend-signal: var(--heron-warning);
}

.backend-node:hover {
  border-color: var(--vp-c-border);
  background: var(--vp-c-bg-elv);
}

.backend-node--selected {
  border-color: color-mix(in srgb, var(--backend-signal) 65%, var(--vp-c-border));
  background: color-mix(in srgb, var(--backend-signal) 7%, var(--vp-c-bg-elv));
  box-shadow: 2px 0 0 var(--backend-signal) inset;
  transform: translateY(-1px);
}

.backend-node:focus-visible {
  outline: 2px solid var(--heron-cyan);
  outline-offset: 2px;
}

.backend-node__socket {
  display: grid;
  width: 1.15rem;
  height: 1.15rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--backend-signal) 62%, var(--vp-c-border));
  border-radius: 50%;
  background: var(--vp-c-bg);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--backend-signal) 8%, transparent);
}

.backend-node__socket i {
  width: 0.35rem;
  height: 0.35rem;
  border-radius: 50%;
  background: var(--backend-signal);
  box-shadow: 0 0 7px color-mix(in srgb, var(--backend-signal) 72%, transparent);
}

.backend-node__name {
  min-width: 0;
  overflow: hidden;
  font-family: var(--vp-font-family-mono);
  font-size: 0.76rem;
  letter-spacing: 0.025em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backend-node__status {
  color: var(--backend-signal);
  font-family: var(--vp-font-family-mono);
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.backend-node__arrow {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  transition: transform 120ms ease;
}

.backend-node--selected .backend-node__arrow {
  color: var(--backend-signal);
  transform: translateX(2px);
}

@media (max-width: 420px) {
  .backend-node {
    grid-template-columns: 1.25rem minmax(0, 1fr) auto;
  }

  .backend-node__arrow {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .backend-node,
  .backend-node__arrow {
    transition: none;
  }
}
</style>

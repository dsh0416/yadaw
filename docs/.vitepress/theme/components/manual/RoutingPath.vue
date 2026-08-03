<script setup lang="ts">
import type { RoutingPathNode } from "./routing-path"

const props = withDefaults(
  defineProps<{
    label: string
    detail: string
    nodes: readonly RoutingPathNode[]
    tone: "main" | "send"
    active?: boolean
    signalStrength?: number
  }>(),
  {
    active: true,
    signalStrength: 1
  }
)
</script>

<template>
  <section
    class="routing-path"
    :class="[`routing-path--${props.tone}`, { 'routing-path--inactive': !props.active }]"
    :style="{ '--signal-strength': props.signalStrength }"
    :aria-label="`${props.label}: ${props.detail}`"
  >
    <header class="routing-path__header">
      <span class="routing-path__key"><i aria-hidden="true" />{{ props.label }}</span>
      <span>{{ props.detail }}</span>
    </header>

    <ol class="routing-path__nodes">
      <li v-for="(node, index) in props.nodes" :key="node.id" class="routing-path__step">
        <div class="routing-path__node">
          <small>{{ node.eyebrow }}</small>
          <strong>{{ node.label }}</strong>
        </div>
        <span v-if="index < props.nodes.length - 1" class="routing-path__wire" aria-hidden="true">
          <i />
        </span>
      </li>
    </ol>
  </section>
</template>

<style scoped>
.routing-path {
  --path-color: var(--yadaw-cyan);
  --path-color-dark: var(--yadaw-cyan-dark);

  min-width: 0;
  padding: 0.85rem;
  border: 1px solid color-mix(in srgb, var(--path-color) 28%, var(--vp-c-divider));
  border-radius: 8px;
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--path-color) 6%, transparent), transparent 48%),
    color-mix(in srgb, var(--vp-c-bg-elv) 72%, transparent);
  transition:
    border-color 160ms ease,
    opacity 160ms ease;
}

.routing-path--send {
  --path-color: var(--yadaw-warning);
  --path-color-dark: color-mix(in srgb, var(--yadaw-warning) 68%, var(--vp-c-text-1));
}

.routing-path--inactive {
  opacity: 0.45;
}

.routing-path__header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.62rem;
  letter-spacing: 0.025em;
}

.routing-path__key {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.45rem;
  color: var(--path-color-dark);
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.routing-path__key i {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--path-color);
  box-shadow: 0 0 8px color-mix(in srgb, var(--path-color) 58%, transparent);
}

.routing-path__nodes {
  display: flex;
  min-width: 0;
  align-items: stretch;
  margin: 0;
  padding: 0;
  list-style: none;
}

.routing-path__step {
  display: flex;
  min-width: 0;
  flex: 1 1 0;
  align-items: center;
  margin: 0;
}

.routing-path__node {
  display: grid;
  min-width: 0;
  min-height: 3.2rem;
  flex: 1 1 auto;
  align-content: center;
  gap: 0.18rem;
  padding: 0.5rem 0.55rem;
  border: 1px solid var(--vp-c-divider);
  border-left: 2px solid var(--path-color);
  border-radius: 5px;
  background: var(--vp-c-bg);
  box-shadow: 0 1px 0 color-mix(in srgb, var(--vp-c-text-1) 5%, transparent) inset;
}

.routing-path__node small,
.routing-path__node strong {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.routing-path__node small {
  color: var(--vp-c-text-3);
  font-family: var(--vp-font-family-mono);
  font-size: 0.52rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.routing-path__node strong {
  color: var(--vp-c-text-1);
  font-family: var(--vp-font-family-mono);
  font-size: 0.66rem;
  font-weight: 650;
}

.routing-path__wire {
  position: relative;
  width: clamp(0.65rem, 2vw, 1.4rem);
  height: 1px;
  flex: none;
  overflow: hidden;
  background: color-mix(
    in srgb,
    var(--path-color) calc(28% + var(--signal-strength) * 42%),
    transparent
  );
}

.routing-path__wire::after {
  position: absolute;
  top: -2px;
  right: 0;
  width: 0;
  height: 0;
  border-top: 2.5px solid transparent;
  border-bottom: 2.5px solid transparent;
  border-left: 4px solid var(--path-color);
  content: "";
}

.routing-path__wire i {
  position: absolute;
  top: -2px;
  left: -0.3rem;
  width: 0.3rem;
  height: 0.3rem;
  border-radius: 50%;
  background: var(--path-color);
  box-shadow: 0 0 6px var(--path-color);
  opacity: calc(0.25 + var(--signal-strength) * 0.75);
  animation: routing-signal 1.8s linear infinite;
}

.routing-path--inactive .routing-path__wire i {
  animation-play-state: paused;
  opacity: 0;
}

@keyframes routing-signal {
  to {
    transform: translateX(clamp(0.65rem, 2vw, 1.4rem));
  }
}

@media (max-width: 620px) {
  .routing-path__header {
    align-items: flex-start;
    flex-direction: column;
    gap: 0.25rem;
  }

  .routing-path__nodes {
    align-items: stretch;
    flex-direction: column;
  }

  .routing-path__step {
    align-items: stretch;
    flex-direction: column;
  }

  .routing-path__node {
    width: 100%;
    min-height: 2.8rem;
  }

  .routing-path__wire {
    width: 1px;
    height: 0.65rem;
    margin-left: 1rem;
    background: color-mix(
      in srgb,
      var(--path-color) calc(28% + var(--signal-strength) * 42%),
      transparent
    );
  }

  .routing-path__wire::after {
    top: auto;
    right: -2px;
    bottom: 0;
    border-top: 4px solid var(--path-color);
    border-right: 2.5px solid transparent;
    border-bottom: 0;
    border-left: 2.5px solid transparent;
  }

  .routing-path__wire i {
    top: -0.3rem;
    left: -2px;
    animation-name: routing-signal-mobile;
  }

  @keyframes routing-signal-mobile {
    to {
      transform: translateY(0.95rem);
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .routing-path,
  .routing-path__wire i {
    animation: none;
    transition: none;
  }
}
</style>

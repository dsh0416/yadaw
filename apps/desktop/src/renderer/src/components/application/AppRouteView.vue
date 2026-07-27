<script setup lang="ts">
import { RouterView } from "vue-router"
</script>

<template>
  <div class="app-route-host">
    <RouterView v-slot="{ Component, route }">
      <Transition name="app-route">
        <div :key="route.fullPath" class="app-route-view">
          <component :is="Component" />
        </div>
      </Transition>
    </RouterView>
  </div>
</template>

<style scoped>
.app-route-host {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  isolation: isolate;
}

.app-route-view {
  position: absolute;
  inset: 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.app-route-enter-active {
  z-index: 1;
  transition:
    opacity 90ms linear,
    transform 110ms cubic-bezier(0.2, 0.8, 0.2, 1);
  will-change: opacity, transform;
}

.app-route-leave-active {
  z-index: 0;
  pointer-events: none;
  transition:
    opacity 70ms linear,
    transform 70ms cubic-bezier(0.4, 0, 1, 1);
  will-change: opacity, transform;
}

.app-route-enter-from {
  opacity: 0.72;
  transform: translateY(3px);
}

.app-route-leave-to {
  opacity: 0;
  transform: translateY(-1px);
}

@media (prefers-reduced-motion: reduce) {
  .app-route-enter-active,
  .app-route-leave-active {
    transition: none;
  }

  .app-route-enter-from,
  .app-route-leave-to {
    opacity: 1;
    transform: none;
  }
}
</style>

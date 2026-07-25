<script setup lang="ts">
import { onMounted, onUnmounted } from "vue"
import AudioBenchmarkDialog from "./AudioBenchmarkDialog.vue"
import { useAudioBenchmark } from "../../composables/useAudioBenchmark"

const benchmark = useAudioBenchmark()
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = window.yadaw.subscribeAudioBenchmarkRequests(benchmark.open)
})

onUnmounted(() => unsubscribe?.())
</script>

<template>
  <Teleport to="body">
    <div v-if="benchmark.isOpen.value" class="benchmark-overlay" @click.self="benchmark.close">
      <AudioBenchmarkDialog
        :status="benchmark.status.value"
        :report="benchmark.report.value"
        :error-message="benchmark.errorMessage.value"
        @close="benchmark.close"
        @run="benchmark.run"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.benchmark-overlay {
  position: fixed;
  z-index: 310;
  inset: 0;
  display: grid;
  place-items: center;
  background:
    radial-gradient(circle at 50% 45%, #18213270, transparent 54%),
    #02050bc9;
  backdrop-filter: blur(8px);
  animation: benchmark-overlay-in 120ms ease-out;
}

@keyframes benchmark-overlay-in {
  from { opacity: 0; }
}
</style>

<script setup lang="ts">
import { storeToRefs } from "pinia"
import AudioBenchmarkDialog from "./AudioBenchmarkDialog.vue"
import { useAudioBenchmarkStore } from "../../stores/audioBenchmark"

const benchmark = useAudioBenchmarkStore()
const { isOpen, status, report, errorMessage } = storeToRefs(benchmark)
</script>

<template>
  <Teleport to="body">
    <div v-if="isOpen" class="benchmark-overlay" @click.self="benchmark.close">
      <AudioBenchmarkDialog
        :status="status"
        :report="report"
        :error-message="errorMessage"
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

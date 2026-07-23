<script setup lang="ts">
import { onMounted, onUnmounted } from "vue"
import { storeToRefs } from "pinia"
import OperationProgressDialog from "./OperationProgressDialog.vue"
import { useOperationStore } from "../../stores/operations"

const store = useOperationStore()
const { active } = storeToRefs(store)
let unsubscribe: (() => void) | null = null

onMounted(() => {
  unsubscribe = window.yadaw.subscribeOperations(store.apply)
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <Teleport to="body">
    <div v-if="active" class="operation-overlay">
      <OperationProgressDialog
        :operation="active"
        @cancel="store.cancel(active.id)"
        @dismiss="store.dismiss(active.id)"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.operation-overlay{position:fixed;z-index:300;inset:0;display:grid;place-items:center;background:#02050bb8;backdrop-filter:blur(6px)}
</style>

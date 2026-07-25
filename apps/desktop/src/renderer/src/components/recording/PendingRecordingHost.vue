<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import { storeToRefs } from "pinia"
import { useRouter } from "vue-router"
import { useRecordingStore } from "../../stores/recording"
import { useStudioWorkflowStore } from "../../stores/studioWorkflow"

const store = useRecordingStore()
const workflowStore = useStudioWorkflowStore()
const router = useRouter()
const { pending } = storeToRefs(store)
const visible = ref(true)
const actionable = computed(() => pending.value.filter((recording) => !recording.assetExists))

onMounted(() => void store.refreshPending())

async function recover(recording: (typeof pending.value)[number]): Promise<void> {
  if (await workflowStore.recoverRecording(recording)) {
    void router.push({ name: "studio" })
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible && actionable.length" class="recovery-overlay">
      <section class="recovery-dialog" role="alertdialog" aria-modal="true" aria-labelledby="recovery-title">
        <span>RECOVERY</span>
        <h2 id="recovery-title">Unfinished recordings found</h2>
        <p>These swap recordings are kept until you recover or explicitly delete them.</p>
        <ul>
          <li v-for="recording in actionable" :key="recording.id">
            <div><b>{{ new Date(recording.startedAt).toLocaleString() }}</b><small>{{ recording.state }} · {{ recording.projectPath }}</small></div>
            <button @click="recover(recording)">Recover</button>
            <button class="danger" @click="store.remove(recording)">Delete</button>
          </li>
        </ul>
        <button class="keep" @click="visible = false">Keep for later</button>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.recovery-overlay{position:fixed;z-index:290;inset:0;display:grid;place-items:center;background:#02050bd9}.recovery-dialog{width:min(680px,calc(100vw - 48px));max-height:calc(100vh - 80px);overflow:auto;padding:26px;border:1px solid var(--line-strong);border-radius:12px;background:#111824;box-shadow:0 30px 90px #000}.recovery-dialog>span{color:var(--warning);font:700 7px var(--font-utility);letter-spacing:.16em}.recovery-dialog h2{margin:8px 0 6px;font:600 20px var(--font-display)}.recovery-dialog>p{margin:0;color:var(--text-muted);font-size:10px}.recovery-dialog ul{display:grid;gap:8px;margin:20px 0;padding:0;list-style:none}.recovery-dialog li{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:8px;padding:12px;border:1px solid var(--line-soft);border-radius:8px;background:#0d131d}.recovery-dialog b,.recovery-dialog small{display:block}.recovery-dialog b{font-size:10px}.recovery-dialog small{margin-top:4px;color:var(--text-faint);font:7px var(--font-utility)}.recovery-dialog button{padding:7px 10px;border:1px solid var(--line-strong);border-radius:6px;color:var(--text-secondary);background:var(--surface-3);cursor:pointer}.recovery-dialog button.danger{color:#ff9dab}.recovery-dialog .keep{float:right}
</style>

<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui"
import { usePluginStore } from "../../stores/plugins"
import PluginParameterPanel from "./PluginParameterPanel.vue"

const pluginStore = usePluginStore()

function handleOpenChange(open: boolean): void {
  if (!open) pluginStore.closeGenericPanel()
}
</script>

<template>
  <DialogRoot :open="Boolean(pluginStore.genericPlugin)" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay class="parameter-dialog-overlay" />
      <DialogContent v-if="pluginStore.genericPlugin" class="parameter-dialog">
        <DialogTitle class="sr-only">
          {{ pluginStore.genericPlugin.descriptor.name }} generic parameters
        </DialogTitle>
        <PluginParameterPanel
          :plugin="pluginStore.genericPlugin"
          :parameters="pluginStore.parameters[pluginStore.genericPlugin.id] ?? []"
          :error="pluginStore.runtime[pluginStore.genericPlugin.id]?.error ?? pluginStore.error"
          @close="pluginStore.closeGenericPanel"
          @begin="
            (id, value) =>
              pluginStore.setParameter({
                instanceId: pluginStore.genericPlugin!.id,
                parameterId: id,
                normalized: value,
                gesture: 'begin'
              })
          "
          @perform="
            (id, value) =>
              pluginStore.setParameter({
                instanceId: pluginStore.genericPlugin!.id,
                parameterId: id,
                normalized: value,
                gesture: 'perform'
              })
          "
          @end="
            (id, value) =>
              pluginStore.setParameter({
                instanceId: pluginStore.genericPlugin!.id,
                parameterId: id,
                normalized: value,
                gesture: 'end'
              })
          "
        />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.parameter-dialog-overlay {
  position: fixed;
  z-index: 60;
  inset: 0;
  background: #08090bb8;
  backdrop-filter: blur(2px);
}
.parameter-dialog {
  position: fixed;
  z-index: 61;
  top: 50%;
  left: 50%;
  width: min(520px, calc(100vw - 40px));
  max-height: min(650px, calc(100vh - 50px));
  overflow: auto;
  transform: translate(-50%, -50%);
  border: 1px solid var(--line-strong);
  border-radius: 7px;
  color: var(--text-primary);
  background: var(--surface-1);
  box-shadow: 0 24px 70px #000000a6;
}
.parameter-dialog :deep(.parameter-panel) {
  border-bottom: 0;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>

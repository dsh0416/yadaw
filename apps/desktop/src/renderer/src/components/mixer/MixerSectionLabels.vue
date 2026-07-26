<template>
  <aside class="mixer-section-labels" aria-hidden="true">
    <span>INPUT</span>
    <span>AUDIO FX</span>
    <span>SENDS</span>
    <span>OUTPUT</span>
    <span>GROUP</span>
    <span>AUTOMATION</span>
    <span>PAN</span>
    <span>VOLUME</span>
    <span>CHANNEL</span>
  </aside>
</template>

<style scoped>
.mixer-section-labels {
  position: sticky;
  left: 0;
  z-index: 7;
  display: grid;
  grid-template-rows:
    54px var(--plugin-section-height) var(--send-section-height) 44px 34px 34px 78px
    282px 40px;
  flex: 0 0 52px;
  min-width: 52px;
  color: #d0d0d0;
  background: #555;
  box-shadow:
    1px 0 0 #1f1f1f,
    7px 0 14px #0000002b;
}

.mixer-section-labels span {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 0 8px 0 4px;
  border-bottom: 1px solid #464646;
  font: 700 7px var(--font-utility);
  letter-spacing: 0.04em;
  text-align: right;
}
</style>

<script setup lang="ts">
import { useData } from "vitepress"
import DefaultTheme from "vitepress/theme-without-fonts"
import AsioTrademarkNotice from "./AsioTrademarkNotice.vue"
import VstTrademarkNotice from "./VstTrademarkNotice.vue"

const { Layout } = DefaultTheme
const { frontmatter } = useData()
</script>

<template>
  <Layout>
    <template #doc-footer-before>
      <div
        v-if="frontmatter.vstTrademark === true || frontmatter.asioTrademark === true"
        class="trademark-notice-stack"
      >
        <VstTrademarkNotice v-if="frontmatter.vstTrademark === true" />
        <AsioTrademarkNotice v-if="frontmatter.asioTrademark === true" />
      </div>
    </template>
  </Layout>
</template>

<style scoped>
.trademark-notice-stack {
  --trademark-logo-width: 24mm;
  --trademark-notice-margin-top: 0;

  display: grid;
  gap: 16px;
  margin-top: 40px;
}
</style>

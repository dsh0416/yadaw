<script setup lang="ts">
import { useData } from "vitepress"
import DefaultTheme from "vitepress/theme-without-fonts"
import VstTrademarkNotice from "./VstTrademarkNotice.vue"

const { Layout } = DefaultTheme
const { frontmatter } = useData()
</script>

<template>
  <Layout>
    <template #doc-footer-before>
      <VstTrademarkNotice v-if="frontmatter.vstTrademark === true" />
    </template>
  </Layout>
</template>

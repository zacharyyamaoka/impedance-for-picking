<script setup lang="ts">
import DefaultTheme from 'vitepress/theme'
import VariantSwitcher from './components/VariantSwitcher.vue'

const { Layout } = DefaultTheme
</script>

<template>
  <Layout>
    <template #layout-bottom>
      <VariantSwitcher />
    </template>
  </Layout>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
</script>

<template>
  <main class="not-found" role="main">
    <p class="code">404</p>
    <h1>页面不存在</h1>
    <p>当前地址没有对应的 OfferFlow 页面。</p>
    <button type="button" @click="router.replace({ name: 'jobs' })">返回岗位台账</button>
  </main>
</template>

<style scoped>
.not-found { max-width: 640px; margin: 80px auto; text-align: center; color: var(--of-ink); }
.code { margin: 0; color: var(--of-brand); font-size: 48px; font-weight: 800; }
h1 { margin: 8px 0; }
p { color: var(--of-ink-2); }
button { margin-top: 16px; padding: 9px 16px; border: 0; border-radius: 8px; background: var(--of-brand); color: #fff; cursor: pointer; }
</style>

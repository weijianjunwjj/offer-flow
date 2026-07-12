<script setup lang="ts">
import { useRouter } from 'vue-router';
import BattlefieldPage from './BattlefieldPage.vue';

const router = useRouter();

function returnToJobs(): void {
  void router.replace({ name: 'jobs' });
}
</script>

<template>
  <BattlefieldPage :job-id="null" @back="returnToJobs" @saved="returnToJobs" />
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import BattlefieldPage from './BattlefieldPage.vue';

const props = defineProps<{ jobId: string | null }>();
const router = useRouter();

function returnToJobs(): void {
  void router.push({ name: 'jobs' });
}
</script>

<template>
  <main v-if="jobId === null" class="invalid-job" role="alert">
    <h1>岗位地址无效</h1>
    <p>岗位 ID 不能为空或超过允许长度。</p>
    <button type="button" @click="returnToJobs">返回岗位台账</button>
  </main>
  <BattlefieldPage v-else :job-id="props.jobId" @back="returnToJobs" @saved="returnToJobs" />
</template>

<style scoped>
.invalid-job { max-width: 640px; margin: 72px auto; text-align: center; }
.invalid-job button { padding: 9px 16px; border: 0; border-radius: 8px; background: var(--of-brand); color: #fff; cursor: pointer; }
</style>

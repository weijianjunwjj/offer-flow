<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import BattlefieldPage from './BattlefieldPage.vue';
import { jobsApi } from '../api/jobsApi';
import { profileApi } from '../api/profileApi';
import { useJobDetailScope } from '../page-scopes/jobDetailScope';

const props = defineProps<{ jobId: string | null }>();
const router = useRouter();
const scope = props.jobId === null
  ? null
  : useJobDetailScope({ jobId: props.jobId, api: { jobs: jobsApi, profile: profileApi } });
const isLoading = computed(() => scope?.$loading.loadDirect === true);

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
  <main v-else-if="scope?.loadError?.kind === 'not-found'" class="invalid-job" role="alert">
    <h1>岗位不存在</h1>
    <p>{{ scope.loadError.message }}</p>
    <button type="button" @click="returnToJobs">返回岗位台账</button>
  </main>
  <main v-else-if="scope?.loadError" class="invalid-job" role="alert">
    <h1>岗位加载失败</h1>
    <p>{{ scope.loadError.message }}</p>
    <button type="button" @click="scope.loadDirect()">重试</button>
    <button type="button" @click="returnToJobs">返回岗位台账</button>
  </main>
  <main v-else-if="isLoading || !scope?.$source.bundle" class="invalid-job" role="status">
    <p>正在加载岗位详情…</p>
  </main>
  <BattlefieldPage v-else :job-id="props.jobId" scope-required @back="returnToJobs" @saved="returnToJobs" />
</template>

<style scoped>
.invalid-job { max-width: 640px; margin: 72px auto; text-align: center; }
.invalid-job button { padding: 9px 16px; border: 0; border-radius: 8px; background: var(--of-brand); color: #fff; cursor: pointer; }
</style>

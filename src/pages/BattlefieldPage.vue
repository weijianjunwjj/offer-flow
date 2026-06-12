<script setup lang="ts">
// Task 2：岗位主战场占位空壳，仅作为台账列表的导航目标。
// 岗位基础信息录入、JD、保存等将在 Task 3 实现；此处不做任何录入与保存。
import { computed } from 'vue';

const props = defineProps<{
  jobId: string | null;
}>();

defineEmits<{
  back: [];
}>();

const modeLabel = computed(() =>
  props.jobId === null ? '新建岗位' : '查看 / 编辑岗位',
);
</script>

<template>
  <main class="battlefield">
    <button class="back-btn" @click="$emit('back')">← 返回台账</button>
    <h1>岗位主战场</h1>
    <p class="mode">
      当前模式：{{ modeLabel }}
      <span v-if="jobId" class="job-id">（岗位 ID：{{ jobId }}）</span>
    </p>
    <p class="todo">
      岗位基础信息录入、JD 与保存将在 Task 3 实现，本页当前为占位空壳。
    </p>
  </main>
</template>

<style scoped>
.battlefield {
  max-width: 760px;
  margin: 0 auto;
  padding: 24px 16px 64px;
  color: #1f2933;
}
.back-btn {
  margin-bottom: 16px;
  padding: 6px 12px;
  border: 1px solid #cbd2d9;
  border-radius: 8px;
  background: #fff;
  font-size: 13px;
  cursor: pointer;
}
.back-btn:hover {
  background: #f2f6ff;
}
h1 {
  margin: 0 0 8px;
  font-size: 22px;
}
.mode {
  margin: 0 0 8px;
  font-size: 14px;
}
.job-id {
  color: #647084;
  font-size: 13px;
}
.todo {
  margin: 0;
  color: #647084;
  font-size: 13px;
}
</style>

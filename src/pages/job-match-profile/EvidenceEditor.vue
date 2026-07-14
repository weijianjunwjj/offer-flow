<script setup lang="ts">
import type { JobMatchEvidenceRef } from '../../domain/job-match-profile';
import { JOB_MATCH_CITY_CODES } from '../../domain/job-match-profile';
import { JOB_MATCH_CITY_LABELS } from '../../domain/presentation';

const props = defineProps<{
  modelValue: JobMatchEvidenceRef[];
  title: string;
  defaultPolarity: 'support' | 'counter';
}>();
const emit = defineEmits<{ 'update:modelValue': [value: JobMatchEvidenceRef[]] }>();

function patch(index: number, patchValue: Partial<JobMatchEvidenceRef>): void {
  emit('update:modelValue', props.modelValue.map((item, itemIndex) => (
    itemIndex === index ? { ...item, ...patchValue } : item
  )));
}

function add(): void {
  emit('update:modelValue', [...props.modelValue, {
    sourceType: 'user_input', sourceId: null, label: '', polarity: props.defaultPolarity,
    strength: 'weak', city: null, summary: '',
  }]);
}

function remove(index: number): void {
  emit('update:modelValue', props.modelValue.filter((_, itemIndex) => itemIndex !== index));
}
</script>

<template>
  <section class="evidence-editor">
    <div class="head"><h4>{{ title }}</h4><button type="button" @click="add">添加证据</button></div>
    <p v-if="modelValue.length === 0" class="empty">尚未记录</p>
    <div v-for="(item, index) in modelValue" :key="index" class="row">
      <input :value="item.label" placeholder="证据名称" @input="patch(index, { label: ($event.target as HTMLInputElement).value })" />
      <select :value="item.sourceType" @change="patch(index, { sourceType: ($event.target as HTMLSelectElement).value as JobMatchEvidenceRef['sourceType'] })">
        <option value="profile">个人档案</option><option value="resume_version">简历版本</option>
        <option value="job">岗位</option><option value="application">求职流程</option>
        <option value="feedback_event">反馈事实</option><option value="user_input">用户补充</option>
      </select>
      <select :value="item.strength" @change="patch(index, { strength: ($event.target as HTMLSelectElement).value as JobMatchEvidenceRef['strength'] })">
        <option value="strong">强证据</option><option value="medium">中等证据</option><option value="weak">弱证据</option>
      </select>
      <select :value="item.city ?? ''" @change="patch(index, { city: (($event.target as HTMLSelectElement).value || null) as JobMatchEvidenceRef['city'] })">
        <option value="">全局</option><option v-for="city in JOB_MATCH_CITY_CODES" :key="city" :value="city">{{ JOB_MATCH_CITY_LABELS[city] }}</option>
      </select>
      <textarea rows="2" :value="item.summary" placeholder="证据摘要" @input="patch(index, { summary: ($event.target as HTMLTextAreaElement).value })" />
      <button type="button" class="remove" @click="remove(index)">移除</button>
    </div>
  </section>
</template>

<style scoped>
.evidence-editor { display: grid; gap: 10px; }
.head { display: flex; align-items: center; justify-content: space-between; }
h4 { margin: 0; font-size: 14px; }
button { border: 1px solid #bfdbfe; border-radius: 8px; padding: 6px 10px; color: #1d4ed8; background: #eff6ff; cursor: pointer; }
.empty { margin: 0; color: #94a3b8; font-size: 12px; }
.row { display: grid; grid-template-columns: 1fr 130px 110px 100px; gap: 8px; padding: 10px; border: 1px solid #e2e8f0; border-radius: 10px; }
input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid #d9e2ef; border-radius: 8px; padding: 8px; background: #fff; font: 12px/1.45 inherit; }
textarea { grid-column: 1 / -2; resize: vertical; }
.remove { color: #b91c1c; border-color: #fecaca; background: #fff1f2; }
@media (max-width: 760px) { .row { grid-template-columns: 1fr; } textarea { grid-column: auto; } }
</style>

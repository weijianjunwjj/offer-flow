<script setup lang="ts">
import type { JobMatchRoleBand } from '../../domain/job-match-profile';
import ListInput from './ListInput.vue';

const props = defineProps<{ modelValue: JobMatchRoleBand; title: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: JobMatchRoleBand] }>();

function patch<K extends keyof JobMatchRoleBand>(key: K, value: JobMatchRoleBand[K]): void {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function salary(key: 'minK' | 'maxK', value: string): void {
  const parsed = value.trim() === '' ? null : Number(value);
  emit('update:modelValue', {
    ...props.modelValue,
    salaryRange: {
      ...props.modelValue.salaryRange,
      [key]: parsed !== null && Number.isFinite(parsed) ? parsed : null,
    },
  });
}
</script>

<template>
  <section class="band-editor">
    <h4>{{ title }}</h4>
    <div class="two-col">
      <ListInput :model-value="modelValue.roleTitles" label="岗位名称" @update:model-value="patch('roleTitles', $event)" />
      <ListInput :model-value="modelValue.roleFamilies" label="岗位族" @update:model-value="patch('roleFamilies', $event)" />
      <ListInput :model-value="modelValue.companySizes" label="公司规模" @update:model-value="patch('companySizes', $event)" />
      <ListInput :model-value="modelValue.companyTypes" label="公司类型" @update:model-value="patch('companyTypes', $event)" />
      <ListInput :model-value="modelValue.industries" label="行业" @update:model-value="patch('industries', $event)" />
      <ListInput :model-value="modelValue.technicalFocus" label="技术定位" @update:model-value="patch('technicalFocus', $event)" />
    </div>
    <div class="salary-grid">
      <label>最低月薪（K）<input type="number" min="0" :value="modelValue.salaryRange.minK ?? ''" @input="salary('minK', ($event.target as HTMLInputElement).value)" /></label>
      <label>最高月薪（K）<input type="number" min="0" :value="modelValue.salaryRange.maxK ?? ''" @input="salary('maxK', ($event.target as HTMLInputElement).value)" /></label>
      <label class="salary-note">薪资说明<input type="text" :value="modelValue.salaryRange.note" @input="emit('update:modelValue', { ...modelValue, salaryRange: { ...modelValue.salaryRange, note: ($event.target as HTMLInputElement).value } })" /></label>
    </div>
    <div class="two-col">
      <ListInput :model-value="modelValue.suitableReasons" label="适配原因" multiline @update:model-value="patch('suitableReasons', $event)" />
      <ListInput :model-value="modelValue.risks" label="风险与不确定性" multiline @update:model-value="patch('risks', $event)" />
    </div>
  </section>
</template>

<style scoped>
.band-editor { padding: 14px; border: 1px solid #e2e8f0; border-radius: 12px; background: #f8fafc; }
h4 { margin: 0 0 12px; color: #0f172a; font-size: 14px; }
.two-col, .salary-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.salary-grid { grid-template-columns: 130px 130px minmax(0, 1fr); margin: 10px 0; }
label { display: grid; gap: 6px; color: #334155; font-size: 12px; font-weight: 650; }
input { box-sizing: border-box; width: 100%; border: 1px solid #d9e2ef; border-radius: 9px; padding: 9px 10px; background: #fff; font: inherit; }
@media (max-width: 720px) { .two-col, .salary-grid { grid-template-columns: 1fr; } }
</style>

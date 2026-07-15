<script setup lang="ts">
import { reactive, ref } from 'vue';
import { NButton, NDatePicker, NInput, NSelect, NSpace } from 'naive-ui';
import {
  CAPABILITY_EVIDENCE_POLARITIES,
  CAPABILITY_EVIDENCE_SOURCE_TYPES,
  CAPABILITY_EVIDENCE_STRENGTHS,
  CAPABILITY_SOURCE_CONFIDENCES,
  CAPABILITY_TIME_PRECISIONS,
  JOB_MATCH_CITY_CODES,
  cloneCandidateEvidenceContent,
  type CandidateEvidenceContent,
} from '../../domain/capability-baseline';
import {
  CAPABILITY_EVIDENCE_POLARITY_LABELS,
  CAPABILITY_EVIDENCE_SOURCE_TYPE_LABELS,
  CAPABILITY_EVIDENCE_STRENGTH_LABELS,
  CAPABILITY_SOURCE_CONFIDENCE_LABELS,
  CAPABILITY_TIME_PRECISION_LABELS,
  JOB_MATCH_CITY_LABELS,
} from '../../domain/presentation';

const props = defineProps<{
  modelValue: CandidateEvidenceContent;
  submitLabel: string;
}>();
const emit = defineEmits<{ submit: [content: CandidateEvidenceContent]; cancel: [] }>();

const form = reactive<CandidateEvidenceContent>(cloneCandidateEvidenceContent(props.modelValue));
const observedTimestamp = ref<number | null>(form.observedAt);

const options = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => ({ label: labels[value], value }));

const polarityOptions = options(CAPABILITY_EVIDENCE_POLARITIES, CAPABILITY_EVIDENCE_POLARITY_LABELS);
const strengthOptions = options(CAPABILITY_EVIDENCE_STRENGTHS, CAPABILITY_EVIDENCE_STRENGTH_LABELS);
const sourceTypeOptions = options(CAPABILITY_EVIDENCE_SOURCE_TYPES, CAPABILITY_EVIDENCE_SOURCE_TYPE_LABELS);
const timePrecisionOptions = options(CAPABILITY_TIME_PRECISIONS, CAPABILITY_TIME_PRECISION_LABELS);
const sourceConfidenceOptions = options(CAPABILITY_SOURCE_CONFIDENCES, CAPABILITY_SOURCE_CONFIDENCE_LABELS);
const cityOptions = [
  { label: '不限定城市', value: '__null__' },
  ...JOB_MATCH_CITY_CODES.map((city) => ({ label: JOB_MATCH_CITY_LABELS[city], value: city })),
];

const cityValue = ref<string>(form.city ?? '__null__');

function handleSubmit(): void {
  form.city = cityValue.value === '__null__' ? null : (cityValue.value as CandidateEvidenceContent['city']);
  form.observedAt = observedTimestamp.value;
  form.sourceId = form.sourceId?.trim() ? form.sourceId.trim() : null;
  emit('submit', cloneCandidateEvidenceContent(form));
}
</script>

<template>
  <form class="evidence-editor" data-evidence-editor @submit.prevent="handleSubmit">
    <div class="grid">
      <label>能力键<NInput v-model:value="form.capabilityKey" placeholder="如 vue_typescript_engineering" /></label>
      <label>能力名称<NInput v-model:value="form.capabilityLabel" placeholder="如 Vue / TypeScript 工程能力" /></label>
      <label>极性<NSelect v-model:value="form.polarity" :options="polarityOptions" /></label>
      <label>强度<NSelect v-model:value="form.strength" :options="strengthOptions" /></label>
      <label>来源类型<NSelect v-model:value="form.sourceType" :options="sourceTypeOptions" /></label>
      <label>来源 ID（可空）<NInput v-model:value="form.sourceId" placeholder="真实来源 ID，或留空" /></label>
      <label>来源标签<NInput v-model:value="form.sourceLabel" placeholder="如 当前主简历" /></label>
      <label>城市<NSelect v-model:value="cityValue" :options="cityOptions" /></label>
      <label>时间精度<NSelect v-model:value="form.timePrecision" :options="timePrecisionOptions" /></label>
      <label>来源可信度<NSelect v-model:value="form.sourceConfidence" :options="sourceConfidenceOptions" /></label>
      <label>观察时间（可空）<NDatePicker v-model:value="observedTimestamp" type="datetime" clearable /></label>
    </div>
    <label class="full">证据说明<NInput v-model:value="form.summary" type="textarea" :rows="3" placeholder="用中文说明这条证据如何支持或反对该能力" /></label>
    <NSpace justify="end">
      <NButton attr-type="button" data-testid="cb-evidence-cancel" @click="emit('cancel')">取消</NButton>
      <NButton attr-type="submit" type="primary" data-testid="cb-evidence-submit">{{ submitLabel }}</NButton>
    </NSpace>
  </form>
</template>

<style scoped>
.evidence-editor { display: flex; flex-direction: column; gap: 14px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: grid; gap: 6px; font-size: 12px; font-weight: 650; color: #334155; }
.full { grid-column: 1 / -1; }
@media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
</style>

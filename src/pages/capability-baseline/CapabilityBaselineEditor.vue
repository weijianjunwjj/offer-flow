<script setup lang="ts">
import { reactive } from 'vue';
import { NButton, NCard, NInput, NSelect, NSpace } from 'naive-ui';
import ListInput from '../job-match-profile/ListInput.vue';
import {
  CAPABILITY_CONCLUSION_STATUSES,
  CAPABILITY_CONSTRAINT_KINDS,
  cloneCapabilityBaselineDraft,
  type CapabilityBaselineDraft,
  type CapabilityConstraintKind,
} from '../../domain/capability-baseline';
import {
  CAPABILITY_CONCLUSION_STATUS_LABELS,
  CAPABILITY_CONSTRAINT_KIND_LABELS,
} from '../../domain/presentation';

const props = defineProps<{
  modelValue: CapabilityBaselineDraft;
  submitLabel: string;
  evidenceOptions: Array<{ label: string; value: string }>;
}>();
const emit = defineEmits<{ submit: [payload: CapabilityBaselineDraft]; cancel: [] }>();

const form = reactive<CapabilityBaselineDraft>(cloneCapabilityBaselineDraft(props.modelValue));

const statusOptions = CAPABILITY_CONCLUSION_STATUSES.map((value) => ({
  label: CAPABILITY_CONCLUSION_STATUS_LABELS[value], value,
}));
const kindOptions = CAPABILITY_CONSTRAINT_KINDS.map((value) => ({
  label: CAPABILITY_CONSTRAINT_KIND_LABELS[value], value,
}));

function addDimension(): void {
  form.capabilities.push({
    key: 'new_capability',
    label: '新能力维度',
    conclusion: '证据不足，尚待验证',
    conclusionStatus: 'insufficient',
    supportingEvidenceRefs: [],
    counterEvidenceRefs: [],
    unverified: ['缺少已接受的支持证据'],
    largestUncertainty: '当前样本不足，暂不形成正式结论',
  });
}
function removeDimension(index: number): void {
  form.capabilities.splice(index, 1);
}
function addConstraint(): void {
  form.externalConstraints.push({
    key: 'external_constraint',
    kind: 'other' as CapabilityConstraintKind,
    label: '外部门槛',
    summary: '属于岗位或市场门槛，非能力事实',
    evidenceRefs: [],
  });
}
function removeConstraint(index: number): void {
  form.externalConstraints.splice(index, 1);
}

function handleSubmit(): void {
  emit('submit', cloneCapabilityBaselineDraft(form));
}
</script>

<template>
  <form class="baseline-editor" data-baseline-editor @submit.prevent="handleSubmit">
    <label class="full">整体概述<NInput v-model:value="form.summary" type="textarea" :rows="2" /></label>
    <label class="full">整体置信状态
      <NSelect v-model:value="form.overallConfidence" :options="statusOptions" />
    </label>
    <ListInput v-model="form.largestUncertainties" label="最大不确定性（每行一项）" multiline />

    <div class="section-head">
      <strong>能力维度</strong>
      <NButton size="small" attr-type="button" data-testid="cb-add-dimension" @click="addDimension">新增维度</NButton>
    </div>
    <NCard v-for="(dim, index) in form.capabilities" :key="index" size="small" class="item">
      <div class="grid">
        <label>能力键<NInput v-model:value="dim.key" /></label>
        <label>能力名称<NInput v-model:value="dim.label" /></label>
        <label>结论状态<NSelect v-model:value="dim.conclusionStatus" :options="statusOptions" /></label>
        <label>最大不确定性<NInput v-model:value="dim.largestUncertainty" /></label>
      </div>
      <label class="full">当前结论<NInput v-model:value="dim.conclusion" type="textarea" :rows="2" /></label>
      <label class="full">支持证据（已接受证据）
        <NSelect v-model:value="dim.supportingEvidenceRefs" multiple :options="evidenceOptions" />
      </label>
      <label class="full">反证（已接受证据）
        <NSelect v-model:value="dim.counterEvidenceRefs" multiple :options="evidenceOptions" />
      </label>
      <ListInput v-model="dim.unverified" label="尚未验证内容（每行一项）" multiline />
      <NButton size="tiny" type="error" ghost attr-type="button" @click="removeDimension(index)">删除该维度</NButton>
    </NCard>

    <div class="section-head">
      <strong>外部门槛（与能力事实分离）</strong>
      <NButton size="small" attr-type="button" data-testid="cb-add-constraint" @click="addConstraint">新增门槛</NButton>
    </div>
    <NCard v-for="(item, index) in form.externalConstraints" :key="`c-${index}`" size="small" class="item">
      <div class="grid">
        <label>门槛键<NInput v-model:value="item.key" /></label>
        <label>门槛类型<NSelect v-model:value="item.kind" :options="kindOptions" /></label>
        <label>名称<NInput v-model:value="item.label" /></label>
      </div>
      <label class="full">说明<NInput v-model:value="item.summary" type="textarea" :rows="2" /></label>
      <label class="full">相关证据
        <NSelect v-model:value="item.evidenceRefs" multiple :options="evidenceOptions" />
      </label>
      <NButton size="tiny" type="error" ghost attr-type="button" @click="removeConstraint(index)">删除该门槛</NButton>
    </NCard>

    <NSpace justify="end">
      <NButton attr-type="button" data-testid="cb-baseline-cancel" @click="emit('cancel')">取消</NButton>
      <NButton attr-type="submit" type="primary" data-testid="cb-baseline-submit">{{ submitLabel }}</NButton>
    </NSpace>
  </form>
</template>

<style scoped>
.baseline-editor { display: flex; flex-direction: column; gap: 14px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: grid; gap: 6px; font-size: 12px; font-weight: 650; color: #334155; }
.full { grid-column: 1 / -1; }
.section-head { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.item { display: flex; flex-direction: column; gap: 10px; }
@media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
</style>

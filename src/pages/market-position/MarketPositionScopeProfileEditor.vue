<script setup lang="ts">
import { reactive } from 'vue';
import { NInput } from 'naive-ui';
import ListInput from '../job-match-profile/ListInput.vue';
import type { MarketPositionScopeProfile } from '../../domain/market-position';

const props = defineProps<{
  modelValue: MarketPositionScopeProfile;
  title: string;
}>();

const form = reactive({
  headline: props.modelValue.headline,
  positioning: props.modelValue.positioning,
  observedStrengths: [...props.modelValue.observedStrengths],
  observedWeaknesses: [...props.modelValue.observedWeaknesses],
  marketSignals: [...props.modelValue.marketSignals],
  counterSignals: [...props.modelValue.counterSignals],
  uncertainties: [...props.modelValue.uncertainties],
  nextEvidenceActions: [...props.modelValue.nextEvidenceActions],
});

defineExpose({
  buildProfile(): MarketPositionScopeProfile {
    return {
      ...props.modelValue,
      headline: form.headline.trim(),
      positioning: form.positioning.trim(),
      observedStrengths: form.observedStrengths,
      observedWeaknesses: form.observedWeaknesses,
      marketSignals: form.marketSignals,
      counterSignals: form.counterSignals,
      uncertainties: form.uncertainties,
      nextEvidenceActions: form.nextEvidenceActions,
    };
  },
});
</script>

<template>
  <section class="scope-editor" :data-testid="`mp-scope-editor-${modelValue.scope.city ?? 'global'}`">
    <h3>{{ title }}</h3>
    <p class="evidence-hint">
      当前证据等级：{{ modelValue.evidenceSufficiency.evidenceLevel }}
      · 只允许在 evidenceSufficiency.allowedClaims 范围内描述，不得使用市场结论、样本充分、成功率预测等禁止措辞。
    </p>
    <label class="field">
      <span>一句话概述</span>
      <NInput v-model:value="form.headline" placeholder="基于当前证据的一句话概述" />
    </label>
    <label class="field">
      <span>定位说明</span>
      <NInput v-model:value="form.positioning" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }" placeholder="定位说明，需与证据等级匹配" />
    </label>
    <div class="grid">
      <ListInput v-model="form.observedStrengths" label="已观察到的优势信号" multiline />
      <ListInput v-model="form.observedWeaknesses" label="已观察到的弱势信号" multiline />
      <ListInput v-model="form.marketSignals" label="市场信号" multiline />
      <ListInput v-model="form.counterSignals" label="反向信号" multiline />
      <ListInput v-model="form.uncertainties" label="不确定性" multiline />
      <ListInput v-model="form.nextEvidenceActions" label="下一步证据行动" multiline />
    </div>
  </section>
</template>

<style scoped>
.scope-editor { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid #e2e8f0; border-radius: 12px; }
.scope-editor h3 { margin: 0; font-size: 15px; }
.evidence-hint { margin: 0; font-size: 12px; color: #64748b; }
.field { display: grid; gap: 6px; font-size: 12px; font-weight: 650; color: #334155; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>

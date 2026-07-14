<script setup lang="ts">
import { reactive, watch } from 'vue';
import {
  JOB_MATCH_CITY_CODES,
  cloneJobMatchProfileDraft,
  type JobMatchProfileDraft,
} from '../../domain/job-match-profile';
import { JOB_MATCH_CITY_LABELS } from '../../domain/presentation';
import EvidenceEditor from './EvidenceEditor.vue';
import ListInput from './ListInput.vue';
import RoleBandEditor from './RoleBandEditor.vue';

const props = defineProps<{ modelValue: JobMatchProfileDraft; submitLabel: string }>();
const emit = defineEmits<{
  submit: [draft: JobMatchProfileDraft];
  cancel: [];
  dirty: [value: boolean];
}>();

const draft = reactive<JobMatchProfileDraft>(cloneJobMatchProfileDraft(props.modelValue));
let syncing = false;
watch(() => props.modelValue, (value) => {
  syncing = true;
  Object.assign(draft, cloneJobMatchProfileDraft(value));
  queueMicrotask(() => { syncing = false; });
}, { deep: true });
watch(draft, () => { if (!syncing) emit('dirty', true); }, { deep: true });

function addCapability(): void {
  draft.coreCapabilities.push({ key: '', label: '', level: 'to_validate', summary: '', evidenceRefs: [] });
}
function removeCapability(index: number): void { draft.coreCapabilities.splice(index, 1); }
function addConstraint(): void {
  draft.constraints.push({ key: '', label: '', summary: '', evidenceRefs: [] });
}
function removeConstraint(index: number): void { draft.constraints.splice(index, 1); }
function handleSubmit(): void { emit('submit', cloneJobMatchProfileDraft(draft)); }
</script>

<template>
  <form class="profile-editor" data-profile-editor @submit.prevent="handleSubmit">
    <section class="editor-section">
      <h3>全局定位</h3>
      <label>当前核心定位<textarea v-model="draft.northStarPositioning" rows="2" required /></label>
      <label>当前最高可达岗位<input v-model="draft.highestReachableRole" required /></label>
      <ListInput v-model="draft.primaryRoleFamilies" label="主攻岗位族" />
      <label>画像置信状态
        <select v-model="draft.confidence"><option value="insufficient">样本不足</option><option value="exploratory">探索性判断</option><option value="actionable">可行动判断</option></select>
      </label>
      <ListInput v-model="draft.largestUncertainties" label="当前最大不确定性" multiline />
    </section>

    <section class="editor-section bands">
      <h3>岗位区间</h3>
      <RoleBandEditor v-model="draft.stretchRoles" title="冲刺岗位" />
      <RoleBandEditor v-model="draft.primaryRoles" title="主攻岗位" />
      <RoleBandEditor v-model="draft.safeRoles" title="稳妥岗位" />
    </section>

    <section class="editor-section">
      <div class="section-head"><h3>当前画像能力摘要</h3><button type="button" @click="addCapability">添加能力</button></div>
      <div v-for="(item, index) in draft.coreCapabilities" :key="index" class="structured-row capability-row">
        <input v-model="item.key" placeholder="能力键" required />
        <input v-model="item.label" placeholder="中文名称" required />
        <select v-model="item.level"><option value="core">核心优势</option><option value="supporting">支撑能力</option><option value="to_validate">待验证能力</option></select>
        <textarea v-model="item.summary" rows="2" placeholder="能力摘要" required />
        <ListInput v-model="item.evidenceRefs" label="证据引用" />
        <button type="button" class="danger" @click="removeCapability(index)">移除</button>
      </div>
    </section>

    <section class="editor-section">
      <div class="section-head"><h3>主要限制</h3><button type="button" @click="addConstraint">添加限制</button></div>
      <div v-for="(item, index) in draft.constraints" :key="index" class="structured-row constraint-row">
        <input v-model="item.key" placeholder="限制键" required />
        <input v-model="item.label" placeholder="中文名称" required />
        <textarea v-model="item.summary" rows="2" placeholder="限制说明" required />
        <ListInput v-model="item.evidenceRefs" label="证据引用" />
        <button type="button" class="danger" @click="removeConstraint(index)">移除</button>
      </div>
    </section>

    <section class="editor-section two-col">
      <div class="subsection">
        <h3>理想公司与团队环境</h3>
        <ListInput v-model="draft.idealEnvironment.companySizes" label="公司规模" />
        <ListInput v-model="draft.idealEnvironment.companyTypes" label="公司类型" />
        <ListInput v-model="draft.idealEnvironment.industries" label="行业" />
        <ListInput v-model="draft.idealEnvironment.teamTraits" label="团队特征" multiline />
        <label>环境说明<textarea v-model="draft.idealEnvironment.description" rows="3" required /></label>
      </div>
      <div class="subsection">
        <h3>可接受范围</h3>
        <ListInput v-model="draft.acceptableRange.roleTitles" label="岗位" />
        <ListInput v-model="draft.acceptableRange.companyTypes" label="公司类型" />
        <ListInput v-model="draft.acceptableRange.workModes" label="办公方式" />
        <label>薪资边界说明<textarea v-model="draft.acceptableRange.salaryNote" rows="2" required /></label>
        <ListInput v-model="draft.acceptableRange.notes" label="其他边界" multiline />
        <div class="city-checks"><span>接受城市</span><label v-for="city in JOB_MATCH_CITY_CODES" :key="city"><input v-model="draft.acceptableRange.cities" type="checkbox" :value="city" />{{ JOB_MATCH_CITY_LABELS[city] }}</label></div>
      </div>
    </section>

    <section class="editor-section city-editor">
      <h3>四城市独立画像</h3>
      <details v-for="city in draft.cityProfiles" :key="city.city" open>
        <summary>{{ JOB_MATCH_CITY_LABELS[city.city] }}</summary>
        <div class="city-body">
          <label>城市结论<textarea v-model="city.summary" rows="2" required /></label>
          <label>当前最高可达岗位<input v-model="city.highestReachableRole" required /></label>
          <label>置信状态<select v-model="city.confidence"><option value="insufficient">样本不足</option><option value="exploratory">探索性判断</option><option value="actionable">可行动判断</option></select></label>
          <label>学历门槛说明<textarea v-model="city.educationBarrier" rows="2" required /></label>
          <label>薪资说明<textarea v-model="city.salaryNote" rows="2" required /></label>
          <ListInput v-model="city.preferredCompanyProfile" label="偏好公司画像" />
          <ListInput v-model="city.missingEvidence" label="缺失证据" multiline />
          <RoleBandEditor v-model="city.stretchRoles" title="冲刺岗位" />
          <RoleBandEditor v-model="city.primaryRoles" title="主攻岗位" />
          <RoleBandEditor v-model="city.safeRoles" title="稳妥岗位" />
          <EvidenceEditor v-model="city.supportingEvidence" title="城市支持证据" default-polarity="support" />
          <EvidenceEditor v-model="city.counterEvidence" title="城市相反证据" default-polarity="counter" />
          <div class="borrowed"><h4>借用证据及降权说明</h4><p v-if="city.borrowedEvidence.length === 0">暂无跨城借用</p>
            <div v-for="(item, index) in city.borrowedEvidence" :key="index" class="borrow-row">
              <select v-model="item.sourceCity"><option v-for="code in JOB_MATCH_CITY_CODES" :key="code" :value="code">{{ JOB_MATCH_CITY_LABELS[code] }}</option></select>
              <input v-model="item.reason" placeholder="借用原因" />
              <input v-model="item.discountNote" placeholder="降权说明" />
              <ListInput v-model="item.notApplicableTo" label="不适用维度" />
              <button type="button" class="danger" @click="city.borrowedEvidence.splice(index, 1)">移除</button>
            </div>
            <button type="button" @click="city.borrowedEvidence.push({ sourceCity: city.city === 'suzhou' ? 'wuxi' : 'suzhou', reason: '', discountNote: '', notApplicableTo: [] })">添加借用说明</button>
          </div>
        </div>
      </details>
    </section>

    <section class="editor-section evidence-grid">
      <EvidenceEditor v-model="draft.supportingEvidence" title="全局支持证据" default-polarity="support" />
      <EvidenceEditor v-model="draft.counterEvidence" title="全局相反证据" default-polarity="counter" />
    </section>

    <div class="editor-actions">
      <button type="button" class="secondary" @click="emit('cancel')">取消</button>
      <button type="submit" class="primary">{{ submitLabel }}</button>
    </div>
  </form>
</template>

<style scoped>
.profile-editor { display: grid; gap: 14px; }
.editor-section { display: grid; gap: 12px; padding: 16px; border: 1px solid #e2e8f0; border-radius: 14px; background: #fff; }
h3, h4 { margin: 0; color: #0f172a; }
h3 { font-size: 16px; } h4 { font-size: 13px; }
label { display: grid; gap: 6px; color: #334155; font-size: 12px; font-weight: 650; }
input, textarea, select { box-sizing: border-box; width: 100%; border: 1px solid #d9e2ef; border-radius: 9px; padding: 9px 10px; color: #0f172a; background: #fff; font: 13px/1.5 inherit; }
textarea { resize: vertical; }
.bands { gap: 14px; }
.section-head { display: flex; align-items: center; justify-content: space-between; }
button { border: 1px solid #bfdbfe; border-radius: 9px; padding: 8px 12px; color: #1d4ed8; background: #eff6ff; font-weight: 650; cursor: pointer; }
.structured-row { display: grid; gap: 8px; padding: 12px; border: 1px solid #e2e8f0; border-radius: 10px; background: #f8fafc; }
.capability-row { grid-template-columns: 130px 1fr 140px; }.capability-row textarea, .capability-row :deep(.list-field) { grid-column: 1 / -1; }
.constraint-row { grid-template-columns: 130px 1fr; }.constraint-row textarea, .constraint-row :deep(.list-field) { grid-column: 1 / -1; }
.danger { color: #b91c1c; border-color: #fecaca; background: #fff1f2; justify-self: start; }
.two-col, .evidence-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.subsection { display: grid; align-content: start; gap: 10px; }
.city-checks { display: flex; flex-wrap: wrap; gap: 10px; color: #334155; font-size: 12px; }.city-checks label { display: flex; align-items: center; gap: 4px; }.city-checks input { width: auto; }
details { border: 1px solid #dbeafe; border-radius: 12px; overflow: hidden; } summary { padding: 12px 14px; color: #1e3a8a; background: #eff6ff; font-weight: 700; cursor: pointer; }
.city-body { display: grid; gap: 12px; padding: 14px; }
.borrowed { display: grid; gap: 8px; }.borrowed p { margin: 0; color: #94a3b8; font-size: 12px; }.borrow-row { display: grid; grid-template-columns: 110px 1fr 1fr; gap: 8px; padding: 10px; border: 1px dashed #cbd5e1; border-radius: 10px; }.borrow-row :deep(.list-field) { grid-column: 1 / -1; }
.editor-actions { position: sticky; bottom: 10px; display: flex; justify-content: flex-end; gap: 10px; padding: 12px; border: 1px solid rgba(226,232,240,.9); border-radius: 12px; background: rgba(255,255,255,.94); box-shadow: 0 10px 30px -20px #0f172a; }
.primary { color: #fff; border-color: #2563eb; background: #2563eb; }.secondary { color: #475569; border-color: #cbd5e1; background: #fff; }
@media (max-width: 760px) { .two-col, .evidence-grid, .capability-row, .constraint-row, .borrow-row { grid-template-columns: 1fr; } .capability-row textarea, .capability-row :deep(.list-field), .constraint-row textarea, .constraint-row :deep(.list-field), .borrow-row :deep(.list-field) { grid-column: auto; } }
</style>

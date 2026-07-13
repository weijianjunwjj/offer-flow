<script setup lang="ts">
import { computed, ref } from 'vue';
import type {
  ApplicationChannel,
  ApplicationMemory,
  ApplicationOrigin,
  EventTimePrecision,
  RecruitingEntityKind,
  ResumeVersionRecord,
  WorkMode,
} from '../../domain/job-memory';
import type { CreateApplicationRequest } from '../../../server/job-memory/dtoSchemas';
import { ApplicationApiError } from '../../api/jobMemoryApi';
import { navigationConfirm } from '../../router/confirmNavigation';
import { isJobDetailBundleV2 } from '../../page-scopes/jobDetailTypes';
import { useInjectedDetailScope } from './sectionScope';
import {
  buildApplicationUpdateRequest,
  createApplicationEditDraft,
  createEmptyApplicationDraft,
  defaultApplicationId,
  fingerprintApplicationDrafts,
  sortApplicationMemories,
  type ApplicationCreateDraft,
} from './applicationSectionModel';
import { encodeEventTime } from './feedbackEventTime';

const props = defineProps<{ scopeRequired: boolean }>();
const scope = useInjectedDetailScope(props.scopeRequired);
const writeError = ref('');

const bundle = computed(() => {
  const current = scope?.$source.bundle ?? null;
  return current !== null && isJobDetailBundleV2(current) ? current : null;
});
const memory = computed(() => bundle.value?.memory ?? null);
const defaultId = computed(() => defaultApplicationId(memory.value?.applications ?? []));
const applications = computed(() => sortApplicationMemories(
  memory.value?.applications ?? [],
  defaultId.value,
));
const selected = computed(() => applications.value.find(
  ({ record }) => record.id === scope?.selectedApplicationId,
) ?? null);
const createDraft = computed(() => scope?.applicationDrafts.create ?? null);
const editDraft = computed(() => scope?.applicationDrafts.edit ?? null);
const voidDraft = computed(() => scope?.applicationDrafts.void ?? null);
const writeInFlight = computed(() => scope?.actionStatus.applicationWrite === 'loading');

const channelOptions: Array<{ value: ApplicationChannel; label: string }> = [
  { value: 'boss', label: 'Boss 直聘' },
  { value: 'official_site', label: '官网' },
  { value: 'referral', label: '内推' },
  { value: 'headhunter', label: '猎头' },
  { value: 'email', label: '邮件' },
  { value: 'wechat', label: '微信' },
  { value: 'other', label: '其他' },
  { value: 'unknown', label: '未知' },
];
const originOptions: Array<{ value: ApplicationOrigin; label: string }> = [
  { value: 'outbound', label: '主动投递 / 接触' },
  { value: 'inbound', label: '招聘方主动联系' },
  { value: 'unknown', label: '来源不确定' },
];
const recruitingOptions: Array<{ value: RecruitingEntityKind; label: string }> = [
  { value: 'direct_employer', label: '直招雇主' },
  { value: 'outsourcing_vendor', label: '外包供应商' },
  { value: 'staffing_agency', label: '人力派遣 / Agency' },
  { value: 'headhunter', label: '猎头' },
  { value: 'unknown', label: '未知' },
];
const workModeOptions: Array<{ value: WorkMode; label: string }> = [
  { value: 'onsite', label: '现场办公' },
  { value: 'hybrid', label: '混合办公' },
  { value: 'remote', label: '远程' },
  { value: 'unknown', label: '未知' },
];

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

function channelLabel(channel: ApplicationChannel, other: string | null): string {
  if (channel === 'other') return other ?? '其他渠道（未填写）';
  return channelOptions.find((option) => option.value === channel)?.label ?? channel;
}

function originLabel(origin: ApplicationOrigin): string {
  return originOptions.find((option) => option.value === origin)?.label ?? origin;
}

function resumeById(id: string | null): ResumeVersionRecord | null {
  if (id === null) return null;
  return memory.value?.resumeVersions.find((resumeVersion) => resumeVersion.id === id) ?? null;
}

function resumeLabel(id: string | null): string {
  if (id === null) return '未知历史版本';
  const resumeVersion = resumeById(id);
  if (resumeVersion === null) return '未知简历版本（引用缺失）';
  return `${resumeVersion.name}${resumeVersion.archivedAt === null ? '' : '（已归档）'}`;
}

function formatTime(value: number | null): string {
  return value === null ? '未知' : new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function statusLabel(application: ApplicationMemory): string {
  if (application.record.voidedAt !== null || application.projection.isVoided) return '已作废';
  if (application.projection.isClosed) return '已关闭';
  return '进行中';
}

function clearFeedback(): void {
  writeError.value = '';
}

function onCreateOriginChange(): void {
  const draft = createDraft.value;
  if (!draft) return;
  if (draft.origin === 'inbound' && draft.initialEventType === 'applied') {
    draft.initialEventType = 'hr_contacted';
  } else if (draft.origin === 'outbound' && draft.initialEventType === 'hr_contacted') {
    draft.initialEventType = 'applied';
  }
}

function markDraftBaseline(): void {
  if (!scope) return;
  scope.applicationDrafts.baselineFingerprint = fingerprintApplicationDrafts(scope.applicationDrafts);
}

function openCreate(): void {
  if (!scope || !memory.value || !bundle.value) return;
  clearFeedback();
  scope.applicationDrafts = {
    create: createEmptyApplicationDraft(
      memory.value.resumeVersions,
      memory.value.activeResumeVersionId,
      bundle.value.job.city,
    ),
    edit: null,
    void: null,
    baselineFingerprint: '',
  };
  markDraftBaseline();
}

function openEdit(application: ApplicationMemory): void {
  if (!scope || application.record.voidedAt !== null) return;
  clearFeedback();
  scope.applicationDrafts = {
    create: null,
    edit: createApplicationEditDraft(application.record),
    void: null,
    baselineFingerprint: '',
  };
  markDraftBaseline();
}

function openVoid(application: ApplicationMemory): void {
  if (!scope || application.record.voidedAt !== null) return;
  clearFeedback();
  scope.applicationDrafts = {
    create: null,
    edit: null,
    void: { applicationId: application.record.id, reason: '', supersededByApplicationId: null },
    baselineFingerprint: '',
  };
  markDraftBaseline();
}

function closeDraft(): void {
  if (!scope || writeInFlight.value) return;
  if (
    scope.isApplicationDirty
    && !navigationConfirm.confirmDiscardChanges('放弃尚未提交的求职流程草稿？')
  ) return;
  scope.applicationDrafts = {
    create: null,
    edit: null,
    void: null,
    baselineFingerprint: '',
  };
  markDraftBaseline();
  clearFeedback();
}

function setSelected(applicationId: string): void {
  if (!scope || applicationId === scope.selectedApplicationId) return;
  if (
    scope.isEventDirty
    && !navigationConfirm.confirmDiscardChanges('切换求职流程会放弃当前反馈事实草稿，是否继续？')
  ) return;
  scope.resetEventDrafts();
  scope.selectedApplicationId = applicationId;
}

function eventAtFromDraft(draft: ApplicationCreateDraft): number | null {
  const parsed = encodeEventTime(draft.initialEventAtInput, draft.initialEventTimePrecision);
  return parsed.ok ? parsed.value : null;
}

function createValidationError(draft: ApplicationCreateDraft): string | null {
  if (draft.channel === 'other' && draft.channelOtherLabel.trim() === '') return '选择其他渠道时请填写渠道名称。';
  if (
    draft.initialEventType !== 'none'
    && draft.initialEventTimePrecision !== 'unknown'
    && eventAtFromDraft(draft) === null
  ) return '已选择事件时间精度，请填写对应发生时间。';
  return null;
}

function buildCreateRequest(draft: ApplicationCreateDraft): CreateApplicationRequest {
  const initialEvent = draft.initialEventType === 'none' ? null : {
    eventType: draft.initialEventType,
    eventAt: eventAtFromDraft(draft),
    timePrecision: draft.initialEventTimePrecision,
    actor: draft.initialEventType === 'hr_contacted' ? 'hr' as const : 'user' as const,
    sourceConfidence: draft.initialEventTimePrecision === 'approximate' ? 'approximate' as const : 'exact' as const,
    evidenceLevel: 'medium' as const,
    channel: draft.channel,
    note: nullableText(draft.initialEventNote),
    reasonCode: null,
    payload: draft.initialEventType === 'hr_contacted'
      ? { submissionState: draft.origin === 'inbound' ? 'not_applied' as const : 'unknown' as const }
      : {},
  };
  return {
    idempotencyKey: draft.idempotencyKey,
    resumeVersionId: draft.resumeVersionId,
    origin: draft.origin,
    channel: draft.channel,
    channelOtherLabel: draft.channel === 'other' ? nullableText(draft.channelOtherLabel) : null,
    recruitingEntity: {
      ...draft.recruitingEntity,
      name: nullableText(draft.recruitingEntity.name ?? ''),
      employerGroupKey: nullableText(draft.recruitingEntity.employerGroupKey ?? ''),
      endClientName: nullableText(draft.recruitingEntity.endClientName ?? ''),
    },
    primaryContact: draft.primaryContact === null ? null : {
      ...draft.primaryContact,
      displayName: nullableText(draft.primaryContact.displayName ?? ''),
      platformId: nullableText(draft.primaryContact.platformId ?? ''),
    },
    cityContext: {
      ...draft.cityContext,
      jobCity: nullableText(draft.cityContext.jobCity ?? ''),
      marketCity: nullableText(draft.cityContext.marketCity ?? ''),
    },
    draftMessageText: nullableText(draft.draftMessageText),
    initialEvent,
  };
}

function readableError(error: unknown): string {
  if (!(error instanceof ApplicationApiError)) return (error as Error).message;
  if (error.code === 'VERSION_CONFLICT') return '数据版本已变化，已重新读取并保留草稿；请核对最新事实后再提交。';
  if (error.code === 'NETWORK_ERROR') return '网络结果不确定，已尝试重新读取；草稿与同一幂等键已保留，可核对列表后重试。';
  if (error.code === 'APPLICATION_ALREADY_VOIDED') return '这条流程已经作废，不能继续修改。';
  return error.message;
}

async function submitCreate(): Promise<void> {
  const draft = createDraft.value;
  if (!scope || !draft || writeInFlight.value) return;
  const validationError = createValidationError(draft);
  if (validationError !== null) {
    writeError.value = validationError;
    return;
  }
  const eventFact = draft.initialEventType === 'none'
    ? '不补记初始事件'
    : `补记 ${draft.initialEventType}，时间精度 ${draft.initialEventTimePrecision}`;
  if (!window.confirm(
    `确认记录一次独立求职流程？\n来源：${originLabel(draft.origin)}\n渠道：${channelLabel(draft.channel, draft.channelOtherLabel)}\n简历：${resumeLabel(draft.resumeVersionId)}\n${eventFact}`,
  )) return;
  clearFeedback();
  try {
    await scope.createApplication(buildCreateRequest(draft));
  } catch (error) {
    writeError.value = readableError(error);
  }
}

const editingMemory = computed(() => applications.value.find(
  ({ record }) => record.id === editDraft.value?.applicationId,
) ?? null);
const updateRequest = computed(() => {
  if (!editDraft.value || !editingMemory.value) return null;
  return buildApplicationUpdateRequest(editingMemory.value.record, editDraft.value);
});

async function submitEdit(): Promise<void> {
  if (!scope || !editDraft.value || !editingMemory.value || !updateRequest.value || writeInFlight.value) return;
  if (editDraft.value.reason.trim() === '') {
    writeError.value = '请填写纠正原因。';
    return;
  }
  if (!window.confirm('确认纠正这条流程的上下文？系统会保留 before/after 审计，不会改写事件事实。')) return;
  clearFeedback();
  try {
    await scope.updateApplication(editingMemory.value.record.id, updateRequest.value);
  } catch (error) {
    writeError.value = readableError(error);
  }
}

const voidingMemory = computed(() => applications.value.find(
  ({ record }) => record.id === voidDraft.value?.applicationId,
) ?? null);
const supersedeOptions = computed(() => applications.value.filter(({ record, projection }) => (
  record.id !== voidDraft.value?.applicationId && record.voidedAt === null && !projection.isVoided
)));

async function submitVoid(): Promise<void> {
  if (!scope || !voidDraft.value || !voidingMemory.value || writeInFlight.value) return;
  if (voidDraft.value.reason.trim() === '') {
    writeError.value = '请填写作废原因。';
    return;
  }
  const superseded = voidDraft.value.supersededByApplicationId === null
    ? '不关联替代流程'
    : `由 ${voidDraft.value.supersededByApplicationId} 替代`;
  if (!window.confirm(`确认作废这条误录流程？\n原因：${voidDraft.value.reason.trim()}\n${superseded}\n这不是“招聘方拒绝”，也不会删除历史。`)) return;
  clearFeedback();
  try {
    await scope.voidApplication(voidingMemory.value.record.id, {
      expectedVersion: voidingMemory.value.record.rowVersion,
      reason: voidDraft.value.reason.trim(),
      supersededByApplicationId: voidDraft.value.supersededByApplicationId,
    });
  } catch (error) {
    writeError.value = readableError(error);
  }
}

function setContactEnabled(enabled: boolean): void {
  const target = createDraft.value ?? editDraft.value;
  if (!target) return;
  target.primaryContact = enabled
    ? { displayName: null, role: 'unknown', platformId: null }
    : null;
}

function eventInputType(precision: EventTimePrecision): 'date' | 'datetime-local' {
  return precision === 'date' ? 'date' : 'datetime-local';
}
</script>

<template>
  <section v-if="bundle" class="application-section" :data-scope-id="scope?.$id">
    <header class="section-head">
      <div>
        <h2>求职流程</h2>
        <p>一条 Application 代表一次独立投递或招聘接触；重复投递会新增记录，不覆盖旧流程。</p>
      </div>
      <button type="button" class="primary-btn" @click="openCreate">
        {{ applications.length === 0 ? '记录一次求职流程' : '再次投递 / 新建流程' }}
      </button>
    </header>

    <p class="decision-context">
      决策上下文：<strong>{{ selected ? `当前流程 ${selected.record.id}` : '岗位级建议' }}</strong>。
      B5 时间线仅展示事件投影；当前 deriveDecision 仍沿用旧 Job 沟通规则，将在 B6 单独切换。
    </p>

    <div v-if="applications.length === 0" class="empty-state">
      <strong>还没有求职流程</strong>
      <p>仅浏览、收藏或准备话术不会自动创建 Application；确认发生真实投递或招聘接触后再记录。</p>
      <button type="button" class="primary-btn" @click="openCreate">记录一次求职流程</button>
    </div>

    <div v-else class="application-list">
      <article
        v-for="application in applications"
        :key="application.record.id"
        class="application-card"
        :class="{ selected: scope?.selectedApplicationId === application.record.id, invalid: application.projection.projectionStatus === 'invalid' }"
      >
        <button type="button" class="card-select" @click="setSelected(application.record.id)">
          <span class="card-title">
            <strong>{{ channelLabel(application.record.channel, application.record.channelOtherLabel) }}</strong>
            <span class="application-id">{{ application.record.id }}</span>
            <i v-if="application.record.id === defaultId">默认</i>
            <i>{{ statusLabel(application) }}</i>
            <i v-if="application.projection.projectionStatus !== 'valid'" class="warn">{{ application.projection.projectionStatus }}</i>
          </span>
          <span class="card-grid">
            <span><b>创建</b>{{ formatTime(application.record.createdAt) }}</span>
            <span><b>来源</b>{{ originLabel(application.record.origin) }}</span>
            <span><b>简历</b>{{ resumeLabel(application.record.resumeVersionId) }}</span>
            <span><b>阶段 / 结果</b>{{ application.projection.stage }} / {{ application.projection.outcome ?? '无' }}</span>
            <span><b>沟通状态</b>{{ application.projection.communicationStatus }}</span>
            <span><b>最近事实</b>{{ formatTime(application.projection.lastMeaningfulEventAt) }}</span>
            <span><b>招聘主体</b>{{ application.record.recruitingEntity.name ?? application.record.recruitingEntity.kind }}</span>
            <span><b>联系人</b>{{ application.record.primaryContact?.displayName ?? '未记录' }}</span>
            <span><b>城市</b>{{ application.record.cityContext.jobCity ?? '未知' }} / {{ application.record.cityContext.marketCity ?? '市场城市未知' }} / {{ application.record.cityContext.workMode }}</span>
          </span>
        </button>
        <ul v-if="application.projection.warnings.length || application.projection.errors.length" class="projection-issues">
          <li v-for="issue in [...application.projection.warnings, ...application.projection.errors]" :key="`${issue.code}-${issue.eventId ?? ''}`">
            {{ issue.code }}：{{ issue.message }}
          </li>
        </ul>
        <footer class="card-actions">
          <button type="button" :disabled="application.record.voidedAt !== null" @click="openEdit(application)">纠正上下文</button>
          <button type="button" class="danger-link" :disabled="application.record.voidedAt !== null" @click="openVoid(application)">作废误录</button>
        </footer>
      </article>
    </div>

    <p v-if="writeError" class="write-error" role="alert">{{ writeError }}</p>

    <div v-if="createDraft" class="modal-backdrop" role="presentation" @click.self="closeDraft">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="application-create-title">
        <header class="modal-head">
          <div>
            <h2 id="application-create-title">记录一次独立求职流程</h2>
            <p>以下事实只有在你确认后才写入；系统不会自动发送、投递或推断历史时间。</p>
          </div>
          <button type="button" class="close-btn" :disabled="writeInFlight" @click="closeDraft">×</button>
        </header>
        <div class="form-grid">
          <label><span>来源</span><select v-model="createDraft.origin" @change="onCreateOriginChange"><option v-for="option in originOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label><span>渠道</span><select v-model="createDraft.channel"><option v-for="option in channelOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label v-if="createDraft.channel === 'other'"><span>其他渠道名称</span><input v-model="createDraft.channelOtherLabel" /></label>
          <label><span>简历版本</span><select v-model="createDraft.resumeVersionId"><option :value="null">未知历史版本</option><option v-for="resume in memory?.resumeVersions" :key="resume.id" :value="resume.id" :disabled="resume.archivedAt !== null">{{ resume.name }}{{ resume.id === memory?.activeResumeVersionId ? '（当前）' : '' }}{{ resume.archivedAt !== null ? '（已归档，不可选）' : '' }}</option></select></label>
          <label><span>招聘主体类型</span><select v-model="createDraft.recruitingEntity.kind"><option v-for="option in recruitingOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label><span>招聘主体名称</span><input v-model="createDraft.recruitingEntity.name" placeholder="可留空" /></label>
          <label><span>最终用工方 / 客户</span><input v-model="createDraft.recruitingEntity.endClientName" placeholder="可留空" /></label>
          <label><span>岗位城市</span><input v-model="createDraft.cityContext.jobCity" /></label>
          <label><span>市场城市</span><input v-model="createDraft.cityContext.marketCity" placeholder="不确定可留空" /></label>
          <label><span>办公方式</span><select v-model="createDraft.cityContext.workMode"><option v-for="option in workModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="wide check"><input type="checkbox" :checked="createDraft.primaryContact !== null" @change="setContactEnabled(($event.target as HTMLInputElement).checked)" /><span>记录主要联系人</span></label>
          <template v-if="createDraft.primaryContact">
            <label><span>联系人名称</span><input v-model="createDraft.primaryContact.displayName" /></label>
            <label><span>联系人角色</span><select v-model="createDraft.primaryContact.role"><option value="company_hr">公司 HR</option><option value="hiring_manager">招聘经理</option><option value="headhunter">猎头</option><option value="platform_recruiter">平台招聘者</option><option value="unknown">未知</option></select></label>
            <label><span>平台标识</span><input v-model="createDraft.primaryContact.platformId" /></label>
          </template>
          <label class="wide"><span>话术草稿（非市场事实）</span><textarea v-model="createDraft.draftMessageText" rows="3" /></label>
          <label><span>初始事件</span><select v-model="createDraft.initialEventType"><option value="none">暂不补记</option><option value="applied">已投递 applied</option><option value="hr_contacted">HR 主动联系 hr_contacted</option></select></label>
          <label v-if="createDraft.initialEventType !== 'none'"><span>时间精度</span><select v-model="createDraft.initialEventTimePrecision"><option value="unknown">时间未知</option><option value="exact">准确到时间</option><option value="date">只知道日期</option><option value="approximate">大约时间</option></select></label>
          <label v-if="createDraft.initialEventType !== 'none' && createDraft.initialEventTimePrecision !== 'unknown'"><span>发生时间</span><input v-model="createDraft.initialEventAtInput" :type="eventInputType(createDraft.initialEventTimePrecision)" /></label>
          <label v-if="createDraft.initialEventType !== 'none'" class="wide"><span>事件备注</span><input v-model="createDraft.initialEventNote" placeholder="可留空" /></label>
        </div>
        <p class="form-hint">主动来源默认建议 applied；招聘方主动联系时可改为 hr_contacted。选择“时间未知”不会伪造当前时间。</p>
        <p v-if="writeError" class="write-error" role="alert">{{ writeError }}</p>
        <footer class="modal-actions"><button type="button" @click="closeDraft">取消</button><button type="button" class="primary-btn" :disabled="writeInFlight" @click="submitCreate">{{ writeInFlight ? '提交中…' : '检查并确认创建' }}</button></footer>
      </section>
    </div>

    <div v-if="editDraft && editingMemory" class="modal-backdrop" role="presentation" @click.self="closeDraft">
      <section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="application-edit-title">
        <header class="modal-head"><div><h2 id="application-edit-title">纠正流程上下文</h2><p>只提交实际变化的白名单字段；来源 origin 和投影状态不可在此修改。</p></div><button type="button" class="close-btn" @click="closeDraft">×</button></header>
        <div class="form-grid">
          <label><span>简历版本</span><select v-model="editDraft.resumeVersionId"><option :value="null">未知历史版本</option><option v-for="resume in memory?.resumeVersions" :key="resume.id" :value="resume.id" :disabled="resume.archivedAt !== null && resume.id !== editingMemory.record.resumeVersionId">{{ resume.name }}{{ resume.archivedAt !== null ? '（已归档）' : '' }}</option></select></label>
          <label><span>渠道</span><select v-model="editDraft.channel"><option v-for="option in channelOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label v-if="editDraft.channel === 'other'"><span>其他渠道名称</span><input v-model="editDraft.channelOtherLabel" /></label>
          <label><span>招聘主体类型</span><select v-model="editDraft.recruitingEntity.kind"><option v-for="option in recruitingOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label><span>招聘主体名称</span><input v-model="editDraft.recruitingEntity.name" /></label>
          <label><span>最终用工方 / 客户</span><input v-model="editDraft.recruitingEntity.endClientName" /></label>
          <label><span>岗位城市</span><input v-model="editDraft.cityContext.jobCity" /></label>
          <label><span>市场城市</span><input v-model="editDraft.cityContext.marketCity" /></label>
          <label><span>办公方式</span><select v-model="editDraft.cityContext.workMode"><option v-for="option in workModeOptions" :key="option.value" :value="option.value">{{ option.label }}</option></select></label>
          <label class="wide check"><input type="checkbox" :checked="editDraft.primaryContact !== null" @change="setContactEnabled(($event.target as HTMLInputElement).checked)" /><span>记录主要联系人</span></label>
          <template v-if="editDraft.primaryContact"><label><span>联系人名称</span><input v-model="editDraft.primaryContact.displayName" /></label><label><span>联系人角色</span><select v-model="editDraft.primaryContact.role"><option value="company_hr">公司 HR</option><option value="hiring_manager">招聘经理</option><option value="headhunter">猎头</option><option value="platform_recruiter">平台招聘者</option><option value="unknown">未知</option></select></label><label><span>平台标识</span><input v-model="editDraft.primaryContact.platformId" /></label></template>
          <label class="wide"><span>话术草稿</span><textarea v-model="editDraft.draftMessageText" rows="3" /></label>
          <label class="wide"><span>纠正原因（必填）</span><input v-model="editDraft.reason" placeholder="说明为什么需要纠正" /></label>
        </div>
        <p v-if="writeError" class="write-error" role="alert">{{ writeError }}</p>
        <footer class="modal-actions"><button type="button" @click="closeDraft">取消</button><button type="button" class="primary-btn" :disabled="writeInFlight || updateRequest === null || editDraft.reason.trim() === ''" @click="submitEdit">确认纠正</button></footer>
      </section>
    </div>

    <div v-if="voidDraft && voidingMemory" class="modal-backdrop" role="presentation" @click.self="closeDraft">
      <section class="modal-card compact" role="dialog" aria-modal="true" aria-labelledby="application-void-title">
        <header class="modal-head"><div><h2 id="application-void-title">作废误录流程</h2><p>作废不是招聘方拒绝；记录仍保留且不可恢复。</p></div><button type="button" class="close-btn" @click="closeDraft">×</button></header>
        <label class="stack"><span>作废原因（必填）</span><textarea v-model="voidDraft.reason" rows="3" /></label>
        <label class="stack"><span>由同岗位另一条流程替代（可选）</span><select v-model="voidDraft.supersededByApplicationId"><option :value="null">不关联替代流程</option><option v-for="application in supersedeOptions" :key="application.record.id" :value="application.record.id">{{ application.record.id }} · {{ channelLabel(application.record.channel, application.record.channelOtherLabel) }}</option></select></label>
        <p v-if="writeError" class="write-error" role="alert">{{ writeError }}</p>
        <footer class="modal-actions"><button type="button" @click="closeDraft">取消</button><button type="button" class="danger-btn" :disabled="writeInFlight || voidDraft.reason.trim() === ''" @click="submitVoid">二次确认并作废</button></footer>
      </section>
    </div>
  </section>
</template>

<style scoped>
.application-section { margin: 20px 0; padding: 22px; border: 1px solid var(--of-line); border-radius: var(--of-radius); background: var(--of-card); box-shadow: var(--of-shadow); }
.section-head, .modal-head, .modal-actions, .card-actions { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.section-head h2, .modal-head h2 { margin: 0 0 5px; }
.section-head p, .modal-head p, .form-hint { margin: 0; color: var(--of-ink-2); font-size: 13px; line-height: 1.6; }
.primary-btn, .danger-btn, .card-actions button, .modal-actions button, .close-btn { border: 0; border-radius: 8px; padding: 8px 13px; cursor: pointer; }
.primary-btn { background: var(--of-brand); color: #fff; }
.danger-btn { background: #dc2626; color: #fff; }
button:disabled { cursor: not-allowed; opacity: .5; }
.decision-context { margin: 16px 0; padding: 10px 12px; border-radius: 9px; background: #eff6ff; color: #334155; font-size: 13px; }
.empty-state { padding: 24px; text-align: center; border: 1px dashed #cbd5e1; border-radius: 12px; }
.empty-state p { color: var(--of-ink-2); }
.application-list { display: grid; gap: 12px; }
.application-card { overflow: hidden; border: 1px solid #e2e8f0; border-radius: 12px; }
.application-card.selected { border-color: #2563eb; box-shadow: 0 0 0 2px rgba(37,99,235,.1); }
.application-card.invalid { border-color: #ef4444; }
.card-select { width: 100%; padding: 15px; border: 0; background: #fff; text-align: left; cursor: pointer; }
.card-title { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.card-title i { padding: 2px 7px; border-radius: 999px; background: #e2e8f0; color: #475569; font-size: 11px; font-style: normal; }
.application-id { color: #94a3b8; font-size: 11px; }
.card-title i.warn { background: #fef3c7; color: #92400e; }
.card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px 16px; color: #334155; font-size: 12px; }
.card-grid span { min-width: 0; overflow-wrap: anywhere; }
.card-grid b { display: block; margin-bottom: 2px; color: #94a3b8; font-size: 11px; }
.card-actions { justify-content: flex-end; padding: 9px 12px; border-top: 1px solid #eef2f7; background: #f8fafc; }
.danger-link { color: #b91c1c; }
.projection-issues { margin: 0; padding: 10px 32px; background: #fffbeb; color: #92400e; font-size: 12px; }
.write-error { margin: 12px 0 0; color: #b91c1c; font-size: 13px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 24px; background: rgba(15,23,42,.42); }
.modal-card { width: min(820px, 100%); max-height: calc(100vh - 48px); overflow: auto; box-sizing: border-box; padding: 22px; border-radius: 16px; background: #fff; box-shadow: 0 24px 80px rgba(15,23,42,.28); }
.modal-card.compact { width: min(560px, 100%); }
.close-btn { padding: 2px 9px; background: #f1f5f9; font-size: 24px; }
.form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 13px; margin-top: 18px; }
.form-grid label, .stack { display: grid; gap: 6px; color: #475569; font-size: 12px; }
.form-grid .wide { grid-column: 1 / -1; }
.form-grid .check { display: flex; align-items: center; }
input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; color: #0f172a; background: #fff; font: inherit; }
.check input { width: auto; }
.form-hint { margin-top: 14px; }
.modal-actions { justify-content: flex-end; margin-top: 20px; }
.stack { margin-top: 16px; }
@media (max-width: 760px) { .section-head { flex-direction: column; } .card-grid, .form-grid { grid-template-columns: 1fr; } .form-grid .wide { grid-column: auto; } .modal-backdrop { padding: 10px; } }
</style>

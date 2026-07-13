<script setup lang="ts">
import type {
  ApplicationChannel,
  EvidenceLevel,
  FeedbackActor,
  SourceConfidence,
} from '../../domain/job-memory';
import {
  REJECTION_REASON_CODES,
  USER_EVENT_GROUPS,
  eventTypeLabel,
  type FeedbackEventFactDraft,
} from './feedbackTimelineModel';

const draft = defineModel<FeedbackEventFactDraft>({ required: true });

const actorOptions: Array<{ value: Exclude<FeedbackActor, 'system'>; label: string }> = [
  { value: 'user', label: '用户本人' },
  { value: 'hr', label: 'HR' },
  { value: 'interviewer', label: '面试官' },
  { value: 'recruiter', label: '招聘者 / 猎头' },
];
const confidenceOptions: Array<{ value: SourceConfidence; label: string }> = [
  { value: 'exact', label: '精确' },
  { value: 'approximate', label: '大约' },
  { value: 'recalled', label: '回忆' },
  { value: 'inferred', label: '推断' },
];
const evidenceOptions: Array<{ value: EvidenceLevel; label: string }> = [
  { value: 'strong', label: '强证据' },
  { value: 'medium', label: '中等证据' },
  { value: 'weak', label: '弱证据' },
];
const channelOptions: Array<{ value: ApplicationChannel | null; label: string }> = [
  { value: null, label: '未记录渠道' },
  { value: 'boss', label: 'Boss 直聘' },
  { value: 'official_site', label: '官网' },
  { value: 'referral', label: '内推' },
  { value: 'headhunter', label: '猎头' },
  { value: 'email', label: '邮件' },
  { value: 'wechat', label: '微信' },
  { value: 'other', label: '其他' },
  { value: 'unknown', label: '未知' },
];

function eventInputType(): 'date' | 'datetime-local' {
  return draft.value.timePrecision === 'date' ? 'date' : 'datetime-local';
}
</script>

<template>
  <div class="event-fields">
    <label>
      <span>事件类型</span>
      <select v-model="draft.eventType" data-event-type>
        <optgroup v-for="group in USER_EVENT_GROUPS" :key="group.label" :label="group.label">
          <option v-for="eventType in group.eventTypes" :key="eventType" :value="eventType">
            {{ eventTypeLabel(eventType) }}（{{ eventType }}）
          </option>
        </optgroup>
      </select>
    </label>
    <label>
      <span>发生时间精度</span>
      <select v-model="draft.timePrecision" data-time-precision>
        <option value="unknown">未知</option>
        <option value="exact">精确时间</option>
        <option value="date">仅日期</option>
        <option value="approximate">大约时间</option>
      </select>
    </label>
    <label v-if="draft.timePrecision !== 'unknown'">
      <span>{{ draft.eventType === 'interview_scheduled' ? '面试 / 事件时间' : '发生时间' }}</span>
      <input v-model="draft.eventAtInput" :type="eventInputType()" data-event-at />
    </label>
    <label>
      <span>事实主体</span>
      <select v-model="draft.actor" data-actor>
        <option v-for="option in actorOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <label>
      <span>来源置信度</span>
      <select v-model="draft.sourceConfidence" data-source-confidence>
        <option v-for="option in confidenceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <label>
      <span>证据强度</span>
      <select v-model="draft.evidenceLevel" data-evidence-level>
        <option v-for="option in evidenceOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <label>
      <span>渠道</span>
      <select v-model="draft.channel" data-channel>
        <option v-for="option in channelOptions" :key="String(option.value)" :value="option.value">{{ option.label }}</option>
      </select>
    </label>
    <label v-if="draft.eventType === 'hr_contacted'">
      <span>当时是否已投递</span>
      <select v-model="draft.hrContactedSubmissionState" data-submission-state>
        <option value="not_applied">确认尚未投递</option>
        <option value="unknown">不确定</option>
      </select>
    </label>
    <label v-if="draft.eventType === 'no_response_recorded'">
      <span>截至何时仍未回复（必填）</span>
      <input v-model="draft.observedAsOfInput" type="datetime-local" data-observed-as-of />
    </label>
    <label v-if="draft.eventType === 'rejected'">
      <span>拒绝原因</span>
      <select v-model="draft.reasonCode" data-reason-code>
        <option value="">未填写</option>
        <option v-for="reason in REJECTION_REASON_CODES" :key="reason" :value="reason">{{ reason }}</option>
      </select>
    </label>
    <label v-else>
      <span>原因代码（可选）</span>
      <input v-model="draft.reasonCode" placeholder="不根据备注自动推断" data-reason-code />
    </label>
    <label class="wide">
      <span>备注（可选）</span>
      <textarea v-model="draft.note" rows="3" data-note />
    </label>
    <p v-if="draft.eventType === 'no_response_recorded'" class="event-note wide">
      这里只记录“截至某时仍未回复”，不会把流程关闭，也不会映射为 rejected。
    </p>
    <p v-else-if="draft.eventType === 'offer_received'" class="event-note wide">
      这里只记录收到 Offer，不会自动接受、拒绝或关闭流程。
    </p>
    <p v-else-if="draft.eventType === 'user_withdrew'" class="event-note wide">
      这是用户主动退出，不代表招聘方拒绝。
    </p>
    <p v-else-if="draft.eventType === 'position_closed' || draft.eventType === 'marked_stale'" class="event-note wide">
      该事实描述岗位或流程状态，不评价用户能力。
    </p>
  </div>
</template>

<style scoped>
.event-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
label { display: grid; gap: 6px; color: #475569; font-size: 12px; }
.wide { grid-column: 1 / -1; }
input, select, textarea { box-sizing: border-box; width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; color: #0f172a; background: #fff; font: inherit; }
.event-note { margin: 0; padding: 9px 11px; border-radius: 8px; background: #f8fafc; color: #64748b; font-size: 12px; line-height: 1.6; }
@media (max-width: 760px) { .event-fields { grid-template-columns: 1fr; } .wide { grid-column: auto; } }
</style>

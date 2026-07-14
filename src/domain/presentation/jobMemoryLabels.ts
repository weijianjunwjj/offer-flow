import type {
  CommunicationStatus,
  ImportStatus,
  ParseStatus,
  ReviewStatus,
  StrategyType,
} from '../../storage/types';
import type {
  ApplicationChannel,
  ApplicationOrigin,
  ApplicationOutcome,
  ApplicationStage,
  ContactRole,
  EventTimePrecision,
  EvidenceLevel,
  FeedbackActor,
  FeedbackEventType,
  FeedbackRecordedBy,
  ProjectionStatus,
  RecruitingEntityKind,
  ResumeVersionSource,
  SourceConfidence,
  SubmissionState,
  WorkMode,
} from '../job-memory/types';

type LabelMap<Code extends string> = Readonly<Record<Code, string>>;

function labelFrom<Code extends string>(
  labels: LabelMap<Code>,
  value: unknown,
  fallback = '未知状态',
): string {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(labels, value)
    ? labels[value as Code]
    : fallback;
}

function optionsFrom<Code extends string>(labels: LabelMap<Code>) {
  return Object.entries(labels).map(([value, label]) => ({
    value: value as Code,
    label: label as string,
  }));
}

export const APPLICATION_STAGE_LABELS = {
  created: '已创建流程',
  applied: '已投递',
  contacted: '沟通中',
  screening: '筛选中',
  interviewing: '面试中',
  offer: '已收到录用意向',
  paused: '流程暂停',
  closed: '流程已关闭',
} satisfies LabelMap<ApplicationStage>;

export const APPLICATION_OUTCOME_LABELS = {
  rejected: '招聘方拒绝',
  user_withdrew: '用户主动退出',
  position_closed: '岗位已关闭',
  stale: '流程已失效',
  offer_declined: '已拒绝录用',
  offer_accepted: '已接受录用',
} satisfies LabelMap<Exclude<ApplicationOutcome, null>>;

export const COMMUNICATION_STATUS_LABELS = {
  not_contacted: '未沟通',
  greeted_unread: '已打招呼（未读）',
  greeted_read_no_reply: '已读未回复',
  replied: '已回复',
  interviewing: '面试推进中',
  paused: '暂停观察',
  closed: '已结束',
  rejected: '已拒绝',
} satisfies LabelMap<CommunicationStatus>;

export const PROJECTION_STATUS_LABELS = {
  valid: '投影正常',
  degraded: '投影需关注',
  invalid: '投影不可用',
} satisfies LabelMap<ProjectionStatus>;

export const FEEDBACK_EVENT_TYPE_LABELS = {
  application_created: '创建求职流程',
  applied: '已投递',
  hr_contacted: '招聘方主动联系',
  greeting_sent: '已发送招呼',
  message_viewed: '消息已读',
  hr_replied: '招聘方已回复',
  resume_requested: '招聘方索要简历',
  phone_screen: '电话初筛',
  interview_scheduled: '已安排面试',
  interview_completed: '已完成面试',
  interview_advanced: '面试已推进',
  follow_up_sent: '已发送跟进',
  no_response_recorded: '记录暂未回复',
  rejected: '招聘方拒绝',
  user_withdrew: '用户主动退出',
  offer_received: '收到录用意向',
  offer_declined: '拒绝录用',
  offer_accepted: '接受录用',
  recruitment_paused: '招聘暂停',
  recruitment_frozen: '招聘冻结',
  process_resumed: '流程恢复',
  position_closed: '岗位关闭',
  marked_stale: '标记流程失效',
  legacy_status_imported: '导入历史状态',
  application_metadata_corrected: '纠正流程信息',
  application_voided: '作废求职流程',
  event_voided: '纠正历史记录',
} satisfies LabelMap<FeedbackEventType>;

export const APPLICATION_ORIGIN_LABELS = {
  outbound: '主动投递或接触',
  inbound: '招聘方主动联系',
  unknown: '来源不确定',
} satisfies LabelMap<ApplicationOrigin>;

export const APPLICATION_CHANNEL_LABELS = {
  boss: 'Boss 直聘',
  official_site: '官网',
  referral: '内推',
  headhunter: '猎头',
  email: '邮件',
  wechat: '微信',
  other: '其他渠道',
  unknown: '未知渠道',
} satisfies LabelMap<ApplicationChannel>;

export const RECRUITING_ENTITY_KIND_LABELS = {
  direct_employer: '直招雇主',
  outsourcing_vendor: '外包供应商',
  staffing_agency: '人力派遣机构',
  headhunter: '猎头',
  unknown: '招聘主体未知',
} satisfies LabelMap<RecruitingEntityKind>;

export const CONTACT_ROLE_LABELS = {
  company_hr: '公司 HR',
  hiring_manager: '招聘经理',
  headhunter: '猎头',
  platform_recruiter: '平台招聘者',
  unknown: '联系人角色未知',
} satisfies LabelMap<ContactRole>;

export const FEEDBACK_ACTOR_LABELS = {
  user: '用户本人',
  hr: '招聘方 HR',
  interviewer: '面试官',
  recruiter: '招聘人员或猎头',
  system: '系统',
} satisfies LabelMap<FeedbackActor>;

export const FEEDBACK_RECORDED_BY_LABELS = {
  user: '用户记录',
  system_migration: '系统迁移记录',
} satisfies LabelMap<FeedbackRecordedBy>;

export const SOURCE_CONFIDENCE_LABELS = {
  exact: '信息准确',
  approximate: '信息大致准确',
  recalled: '根据回忆记录',
  inferred: '系统推断',
} satisfies LabelMap<SourceConfidence>;

export const EVIDENCE_LEVEL_LABELS = {
  strong: '强证据',
  medium: '中等证据',
  weak: '弱证据',
} satisfies LabelMap<EvidenceLevel>;

export const TIME_PRECISION_LABELS = {
  exact: '精确时间',
  date: '仅日期',
  approximate: '大约时间',
  unknown: '时间未知',
} satisfies LabelMap<EventTimePrecision>;

export const WORK_MODE_LABELS = {
  onsite: '现场办公',
  hybrid: '混合办公',
  remote: '远程办公',
  unknown: '办公方式未知',
} satisfies LabelMap<WorkMode>;

export const RESUME_VERSION_SOURCE_LABELS = {
  profile_snapshot: '当前档案快照',
  pasted_text: '粘贴文本',
  imported_file_text: '导入文件文本',
} satisfies LabelMap<ResumeVersionSource>;

export const SUBMISSION_STATE_LABELS = {
  applied: '已投递',
  not_applied: '尚未投递',
  unknown: '投递情况未知',
} satisfies LabelMap<SubmissionState>;

export const IMPORT_STATUS_LABELS = {
  draft: '导入草稿',
  imported_draft: '待审核的导入草稿',
} satisfies LabelMap<ImportStatus>;

export const REVIEW_STATUS_LABELS = {
  pending_review: '待人工确认',
  confirmed: '已确认',
  deferred: '已暂缓',
  rejected: '已拒绝',
} satisfies LabelMap<ReviewStatus>;

export const PARSE_STATUS_LABELS = {
  none: '暂无解析结果',
  parsed: '已解析',
  unparsed: '未解析，原文已保存',
} satisfies LabelMap<ParseStatus>;

type ImportedRecommendationCode = StrategyType | 'wait_review';

export const IMPORTED_RECOMMENDATION_LABELS = {
  main_attack: '主攻',
  low_cost_probe: '低成本试探',
  cautious_watch: '谨慎观察',
  cut_loss: '建议止损',
  wait_review: '待人工确认',
} satisfies LabelMap<ImportedRecommendationCode>;

export const REASON_CODE_LABELS = {
  education: '学历要求不匹配',
  salary: '薪资条件不匹配',
  skills: '技能要求不匹配',
  experience: '经验要求不匹配',
  headcount: '招聘名额调整',
  position_closed: '岗位已关闭',
  unknown: '原因未知',
  other: '其他原因',
} as const satisfies LabelMap<string>;

export const APPLICATION_CHANNEL_OPTIONS = optionsFrom(APPLICATION_CHANNEL_LABELS);
export const APPLICATION_ORIGIN_OPTIONS = optionsFrom(APPLICATION_ORIGIN_LABELS);
export const RECRUITING_ENTITY_KIND_OPTIONS = optionsFrom(RECRUITING_ENTITY_KIND_LABELS);
export const CONTACT_ROLE_OPTIONS = optionsFrom(CONTACT_ROLE_LABELS);
export const WORK_MODE_OPTIONS = optionsFrom(WORK_MODE_LABELS);
export const COMMUNICATION_STATUS_OPTIONS = optionsFrom(COMMUNICATION_STATUS_LABELS);
export const SOURCE_CONFIDENCE_OPTIONS = optionsFrom(SOURCE_CONFIDENCE_LABELS);
export const EVIDENCE_LEVEL_OPTIONS = optionsFrom(EVIDENCE_LEVEL_LABELS);

export const formatApplicationStageLabel = (value: unknown) => labelFrom(APPLICATION_STAGE_LABELS, value);
export const formatApplicationOutcomeLabel = (value: unknown) => value === null
  ? '暂无结果'
  : labelFrom(APPLICATION_OUTCOME_LABELS, value);
export const formatCommunicationStatusLabel = (value: unknown) => labelFrom(COMMUNICATION_STATUS_LABELS, value);
export const formatProjectionStatusLabel = (value: unknown) => labelFrom(PROJECTION_STATUS_LABELS, value);
export const formatFeedbackEventTypeLabel = (value: unknown) => labelFrom(FEEDBACK_EVENT_TYPE_LABELS, value);
export const formatApplicationOriginLabel = (value: unknown) => labelFrom(APPLICATION_ORIGIN_LABELS, value);
export const formatApplicationChannelLabel = (value: unknown, other?: string | null) => value === 'other' && other?.trim()
  ? other.trim()
  : labelFrom(APPLICATION_CHANNEL_LABELS, value, '未知渠道');
export const formatRecruitingEntityKindLabel = (value: unknown) => labelFrom(RECRUITING_ENTITY_KIND_LABELS, value);
export const formatContactRoleLabel = (value: unknown) => labelFrom(CONTACT_ROLE_LABELS, value);
export const formatActorLabel = (value: unknown) => labelFrom(FEEDBACK_ACTOR_LABELS, value);
export const formatRecordedByLabel = (value: unknown) => labelFrom(FEEDBACK_RECORDED_BY_LABELS, value);
export const formatSourceConfidenceLabel = (value: unknown) => labelFrom(SOURCE_CONFIDENCE_LABELS, value);
export const formatEvidenceLevelLabel = (value: unknown) => labelFrom(EVIDENCE_LEVEL_LABELS, value);
export const formatTimePrecisionLabel = (value: unknown) => labelFrom(TIME_PRECISION_LABELS, value);
export const formatWorkModeLabel = (value: unknown) => labelFrom(WORK_MODE_LABELS, value);
export const formatResumeVersionSourceLabel = (value: unknown) => labelFrom(RESUME_VERSION_SOURCE_LABELS, value);
export const formatSubmissionStateLabel = (value: unknown) => labelFrom(SUBMISSION_STATE_LABELS, value);
export const formatImportStatusLabel = (value: unknown) => labelFrom(IMPORT_STATUS_LABELS, value);
export const formatReviewStatusLabel = (value: unknown) => value === undefined
  ? '未进入审核'
  : labelFrom(REVIEW_STATUS_LABELS, value);
export const formatParseStatusLabel = (value: unknown) => labelFrom(PARSE_STATUS_LABELS, value);
export const formatImportedRecommendationLabel = (value: unknown) => labelFrom(
  IMPORTED_RECOMMENDATION_LABELS,
  value,
  '待人工确认',
);
export const formatReasonCodeLabel = (value: unknown) => value === null || value === ''
  ? '未记录原因'
  : labelFrom(REASON_CODE_LABELS, value, '未知原因');

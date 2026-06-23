// v0.2 默认值与旧数据兼容（DEC-016）。
// 仅负责「补齐默认值」这一件事：新建岗位的初值，以及读取旧岗位时回填新增字段。
// 不做解析 / 计算 / 校验业务逻辑（那些在 src/app/ 下）。

import type {
  JobRecord,
  CompanyInput,
  CommunicationStatus,
  LegacyContactStatus,
} from './types';

/** 读取旧数据时需要补齐 / 迁移的 JobRecord 字段名 */
type JobRecordDefaultKeys =
  | 'companyInput'
  | 'companyAssessment'
  | 'opportunityAnalysis'
  | 'communicationStatus'
  | 'followupCount';

/**
 * 旧版持久化形状：保证含基础字段，后续新增字段视为可选。
 * 用于读取时把任意历史岗位安全地补齐为完整 JobRecord。
 */
export type StoredJobRecord = Omit<JobRecord, JobRecordDefaultKeys> &
  Partial<Pick<JobRecord, JobRecordDefaultKeys>> & {
    contactStatus?: LegacyContactStatus;
    contactStatusUpdatedAt?: number;
  };

const COMMUNICATION_STATUSES: ReadonlySet<string> = new Set([
  'not_contacted',
  'greeted_unread',
  'greeted_read_no_reply',
  'replied',
  'interviewing',
  'paused',
  'closed',
  'rejected',
]);

function isCommunicationStatus(value: unknown): value is CommunicationStatus {
  return typeof value === 'string' && COMMUNICATION_STATUSES.has(value);
}

function mapLegacyContactStatus(value: unknown): CommunicationStatus {
  switch (value) {
    case 'not_contacted':
      return 'not_contacted';
    case 'greeted':
      return 'greeted_unread';
    case 'replied':
      return 'replied';
    case 'interview_scheduled':
      return 'interviewing';
    case 'rejected':
      return 'rejected';
    case 'closed':
      return 'closed';
    default:
      return 'not_contacted';
  }
}

/** 空的公司与机会补充信息（新建岗位 / 旧数据兜底用） */
export function emptyCompanyInput(): CompanyInput {
  return {
    sizeTier: 'unknown',
    staffRange: '',
    companyType: '',
    financingStage: '',
    commuteTime: '',
    commuteWay: '',
    companyNote: '',
    opportunityNote: '',
  };
}

/**
 * 把已解析的岗位对象补齐 v0.2 新增字段的默认值。
 * 只补缺失字段，不覆盖已有值；不抛错。旧岗位读取后即可当作完整 JobRecord 使用。
 */
export function withJobRecordDefaults(parsed: StoredJobRecord): JobRecord {
  const rest = { ...parsed };
  delete rest.contactStatus;
  delete rest.contactStatusUpdatedAt;
  return {
    ...rest,
    companyInput: { ...emptyCompanyInput(), ...(parsed.companyInput ?? {}) },
    companyAssessment: parsed.companyAssessment ?? null,
    opportunityAnalysis: parsed.opportunityAnalysis ?? null,
    communicationStatus: isCommunicationStatus(parsed.communicationStatus)
      ? parsed.communicationStatus
      : mapLegacyContactStatus(parsed.contactStatus),
    followupCount: parsed.followupCount ?? 0,
    highValueSignal: parsed.highValueSignal ?? false,
  };
}

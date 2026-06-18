// v0.2 默认值与旧数据兼容（DEC-016）。
// 仅负责「补齐默认值」这一件事：新建岗位的初值，以及读取旧岗位时回填新增字段。
// 不做解析 / 计算 / 校验业务逻辑（那些在 src/app/ 下）。

import type { JobRecord, CompanyInput } from './types';

/** v0.2 新增、旧数据可能缺失的 JobRecord 字段名 */
type JobRecordV2Keys = 'companyInput' | 'companyAssessment' | 'opportunityAnalysis';

/**
 * 旧版（v0.1）持久化形状：保证含 v0.1 全部字段，v0.2 新增字段视为可选。
 * 用于读取时把任意历史岗位安全地补齐为完整 JobRecord。
 */
export type StoredJobRecord = Omit<JobRecord, JobRecordV2Keys> &
  Partial<Pick<JobRecord, JobRecordV2Keys>>;

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
  return {
    ...parsed,
    companyInput: { ...emptyCompanyInput(), ...(parsed.companyInput ?? {}) },
    companyAssessment: parsed.companyAssessment ?? null,
    opportunityAnalysis: parsed.opportunityAnalysis ?? null,
  };
}

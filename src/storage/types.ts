// OfferFlow v0.1 — Step 0 data shapes.
// This file describes ONLY what we persist. No logic lives here.

/** 当前求职重点:求稳 / 涨薪 / 履历 / 技术成长 */
export type JobSearchFocus = 'stability' | 'raise' | 'resume' | 'growth';

/** 全局求职档案(单条,全局唯一,覆盖式保存) */
export interface JobSeekerProfile {
  resumeText: string;
  projectExperience: string;
  targetCity: string;
  targetRole: string;
  expectedSalary: string;
  acceptOutsourcing: boolean;
  acceptOvertime: boolean;
  jobSearchFocus: JobSearchFocus;
  weaknessNote: string;
}

/** 投递建议四档 */
export type ApplyAdvice = 'strongly' | 'ok' | 'cautious' | 'skip';

/**
 * 岗位分析报告。Step 0 只负责让它原样存取(round-trip),
 * 不在这一步做任何解析 / 生成逻辑。
 */
export interface JobReport {
  jobType: string;
  keywords: string;
  techStackMatch: string;
  projectMatch: string;
  strengths: string;
  risks: string;
  resumeAdvice: string;
  interviewChecklist: string;
  applyAdvice: ApplyAdvice | '';
  greetingMessage: string;
}

/** 沟通状态:未沟通 / 已打招呼 / 已回复 / 已约面 / 已拒绝 / 已结束 */
export type ContactStatus =
  | 'not_contacted'
  | 'greeted'
  | 'replied'
  | 'interview_scheduled'
  | 'rejected'
  | 'closed';

/** AI 结果解析状态。Step 0 只存这个标记位,不依据它做分支逻辑 */
export type ParseStatus = 'none' | 'parsed' | 'unparsed';

/** 岗位记录(多条,一条一个存储项,不做大对象整存整取) */
export interface JobRecord {
  id: string;
  createdAt: number;
  updatedAt: number;

  // 基础信息
  company: string;
  role: string;
  city: string;
  salaryRange: string;
  jdText: string;

  // 生成产物(允许为空 / 可重生成)
  promptText: string;

  // AI 承接(原文必存优先,Step 0 只存不解析)
  aiRawResult: string;
  aiPastedAt: number | null;
  parseStatus: ParseStatus;

  // 报告内容(承接或手填,Step 0 不计算)
  report: JobReport | null;
  matchScore: string;

  // 沟通台账
  contactStatus: ContactStatus;
  contactStatusUpdatedAt: number;
}

/** 新建岗位时只收基础信息,其余字段由 store 填默认值 */
export interface JobCreateInput {
  company?: string;
  role?: string;
  city?: string;
  salaryRange?: string;
  jdText?: string;
}

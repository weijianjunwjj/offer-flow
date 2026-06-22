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

/** v0.3 沟通状态：Boss 聊天语境下的当前事实状态（DEC-020）。 */
export type CommunicationStatus =
  | 'not_contacted'
  | 'greeted_unread'
  | 'greeted_read_no_reply'
  | 'replied'
  | 'interviewing'
  | 'paused'
  | 'closed'
  | 'rejected';

/** v0.1/v0.2 旧沟通状态，仅用于读取历史数据迁移，不再写入新记录。 */
export type LegacyContactStatus =
  | 'not_contacted'
  | 'greeted'
  | 'replied'
  | 'interview_scheduled'
  | 'rejected'
  | 'closed';

/** AI 结果解析状态。Step 0 只存这个标记位,不依据它做分支逻辑 */
export type ParseStatus = 'none' | 'parsed' | 'unparsed';

// ===========================================================================
// v0.2 机会雷达数据结构（DEC-016）。
// 仍只描述「持久化形状」，不含任何解析 / 计算逻辑（解析见 Task 6 offerFlowJson.ts，
// 计算见 Task 6 opportunityScore.ts）。不新增独立实体，全部挂在 JobRecord 上。
// ===========================================================================

/** 公司规模档位 */
export type CompanySizeTier =
  | 'giant' // 大厂：10000+
  | 'large' // 大中厂：1000-9999
  | 'medium' // 中厂：100-999
  | 'small' // 小厂：20-99
  | 'micro' // 微厂：0-20
  | 'unknown';

/** 稳定性 */
export type StabilityLevel = 'high' | 'medium' | 'low' | 'unknown';
/** 成长性 */
export type GrowthPotential = 'high' | 'medium' | 'low' | 'unknown';
/** 风险等级 */
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

/** 公司与机会补充信息（用户填写） */
export interface CompanyInput {
  sizeTier: CompanySizeTier;
  staffRange: string;
  companyType: string;
  financingStage: string;
  commuteTime: string;
  commuteWay: string;
  companyNote: string;
  opportunityNote: string;
}

/** 公司画像（外部 AI 解析结果） */
export interface CompanyAssessment {
  sizeTier: CompanySizeTier;
  staffRange: string;
  companyType: string;
  financingStage: string;
  stabilityLevel: StabilityLevel;
  growthPotential: GrowthPotential;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
}

/** 6 维机会雷达（每维 0-100） */
export interface OpportunityRadar {
  salaryScore: number; // 薪资
  stabilityScore: number; // 稳定
  growthScore: number; // 成长
  matchScore: number; // 匹配
  commuteScore: number; // 通勤
  riskControlScore: number; // 风险可控
}

/** 机会分析（外部 AI 解析结果） */
export interface OpportunityAnalysis {
  opportunityScore: number;
  opportunityRadar: OpportunityRadar;
  applyAdvice: ApplyAdvice | '';
  riskLevel: RiskLevel;
  decisionSummary: string;
  interviewFocus: string[];
  bossGreeting: string;
}

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

  // v0.2 机会雷达(DEC-016)：companyInput 用户填写；后两者由 AI 结果解析回填,未解析为 null
  companyInput: CompanyInput;
  companyAssessment: CompanyAssessment | null;
  opportunityAnalysis: OpportunityAnalysis | null;

  // 沟通台账（v0.3：只写 communicationStatus，不再写 contactStatus）
  communicationStatus: CommunicationStatus;
}

/** 新建岗位时只收基础信息,其余字段由 store 填默认值 */
export interface JobCreateInput {
  company?: string;
  role?: string;
  city?: string;
  salaryRange?: string;
  jdText?: string;
}

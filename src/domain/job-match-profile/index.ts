import { z } from 'zod';

const RequiredTextSchema = z.string().trim().min(1);
const TextListSchema = z.array(RequiredTextSchema).max(30);

export const JobMatchCityCodeSchema = z.enum([
  'global',
  'suzhou',
  'wuxi',
  'shanghai',
  'hangzhou',
]);
export type JobMatchCityCode = z.infer<typeof JobMatchCityCodeSchema>;

export const JobMatchConfidenceStateSchema = z.enum([
  'insufficient',
  'exploratory',
  'actionable',
]);
export type JobMatchConfidenceState = z.infer<typeof JobMatchConfidenceStateSchema>;

export const JobMatchEvidenceSchema = z.strictObject({
  id: RequiredTextSchema,
  statement: RequiredTextSchema,
  sourceType: z.enum([
    'profile',
    'resume',
    'project',
    'application',
    'feedback',
    'user_input',
    'borrowed_city',
  ]),
  sourceLabel: RequiredTextSchema,
  sourceCity: JobMatchCityCodeSchema.nullable(),
  polarity: z.enum(['support', 'counter', 'uncertainty']),
  weight: z.number().min(0).max(1),
  borrowed: z.boolean(),
  borrowingReason: z.string().trim().nullable(),
  notApplicableTo: TextListSchema,
});
export type JobMatchEvidence = z.infer<typeof JobMatchEvidenceSchema>;

export const JobMatchBandSchema = z.strictObject({
  label: z.enum(['stretch', 'focus', 'safe']),
  roles: TextListSchema,
  salaryRange: RequiredTextSchema,
  companyRange: TextListSchema,
  notes: TextListSchema,
});
export type JobMatchBand = z.infer<typeof JobMatchBandSchema>;

export const JobMatchProfileViewSchema = z.strictObject({
  scope: JobMatchCityCodeSchema,
  headline: RequiredTextSchema,
  corePositioning: RequiredTextSchema,
  highestReachableRole: RequiredTextSchema,
  stretch: JobMatchBandSchema,
  focus: JobMatchBandSchema,
  safe: JobMatchBandSchema,
  strengths: TextListSchema,
  capabilitiesToValidate: TextListSchema,
  constraints: TextListSchema,
  idealEnvironment: TextListSchema,
  acceptableRange: TextListSchema,
  supportEvidence: z.array(JobMatchEvidenceSchema).max(50),
  counterEvidence: z.array(JobMatchEvidenceSchema).max(50),
  biggestUncertainties: TextListSchema,
  confidenceState: JobMatchConfidenceStateSchema,
  confidenceReason: RequiredTextSchema,
  blockedConclusions: TextListSchema,
});
export type JobMatchProfileView = z.infer<typeof JobMatchProfileViewSchema>;

export const JobMatchProfileDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  title: RequiredTextSchema,
  summary: RequiredTextSchema,
  global: JobMatchProfileViewSchema,
  suzhou: JobMatchProfileViewSchema,
  wuxi: JobMatchProfileViewSchema,
  shanghai: JobMatchProfileViewSchema,
  hangzhou: JobMatchProfileViewSchema,
});
export type JobMatchProfileDraft = z.infer<typeof JobMatchProfileDraftSchema>;

export const JobMatchProposalStatusSchema = z.enum([
  'proposed',
  'accepted',
  'modified_and_accepted',
  'rejected',
  'deferred',
  'expired',
]);
export type JobMatchProposalStatus = z.infer<typeof JobMatchProposalStatusSchema>;

const JobMatchDecisionSchema = z.strictObject({
  action: z.enum(['accepted', 'modified_and_accepted', 'rejected', 'deferred']),
  note: z.string(),
  decidedAt: z.number().int().nonnegative(),
  deferredUntil: z.number().int().nonnegative().nullable(),
});

const JobMatchAiRunSchema = z.strictObject({
  model: RequiredTextSchema,
  promptVersion: RequiredTextSchema,
  rawText: z.string(),
  createdAt: z.number().int().nonnegative(),
});

export const JobMatchProfileProposalSchema = z.strictObject({
  id: RequiredTextSchema,
  source: z.enum(['manual', 'ai']),
  status: JobMatchProposalStatusSchema,
  createdAt: z.number().int().nonnegative(),
  draft: JobMatchProfileDraftSchema,
  decision: JobMatchDecisionSchema.nullable(),
  aiRun: JobMatchAiRunSchema.nullable(),
});
export type JobMatchProfileProposal = z.infer<typeof JobMatchProfileProposalSchema>;

export const JobMatchProfileVersionSchema = z.strictObject({
  id: RequiredTextSchema,
  versionNumber: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
  activatedAt: z.number().int().nonnegative(),
  sourceProposalId: RequiredTextSchema,
  supersedesVersionId: z.string().trim().min(1).nullable(),
  changeNote: z.string(),
  draft: JobMatchProfileDraftSchema,
});
export type JobMatchProfileVersion = z.infer<typeof JobMatchProfileVersionSchema>;

export const JobMatchProfileStateSchema = z.strictObject({
  stateVersion: z.number().int().nonnegative(),
  activeVersionId: z.string().trim().min(1).nullable(),
  proposals: z.array(JobMatchProfileProposalSchema),
  versions: z.array(JobMatchProfileVersionSchema),
});
export type JobMatchProfileState = z.infer<typeof JobMatchProfileStateSchema>;

export interface JobMatchProfileSeed {
  resumeText: string;
  projectExperience: string;
  targetCity: string;
  targetRole: string;
  expectedSalary: string;
  weaknessNote: string;
}

export interface CreateProposalInput {
  id: string;
  source: 'manual' | 'ai';
  draft: JobMatchProfileDraft;
  createdAt: number;
  aiRun?: {
    model: string;
    promptVersion: string;
    rawText: string;
    createdAt: number;
  } | null;
}

export interface DecideProposalInput {
  proposalId: string;
  action: 'accept' | 'modify_and_accept' | 'reject' | 'defer';
  now: number;
  versionId?: string;
  modifiedDraft?: JobMatchProfileDraft;
  note?: string;
  deferredUntil?: number | null;
}

export function createEmptyJobMatchProfileState(): JobMatchProfileState {
  return {
    stateVersion: 0,
    activeVersionId: null,
    proposals: [],
    versions: [],
  };
}

export function parseJobMatchProfileState(value: unknown): JobMatchProfileState {
  if (value === undefined || value === null) return createEmptyJobMatchProfileState();
  return JobMatchProfileStateSchema.parse(value);
}

function evidenceFromSeed(seed: JobMatchProfileSeed): JobMatchEvidence[] {
  const evidence: JobMatchEvidence[] = [];
  if (seed.targetRole.trim() !== '') {
    evidence.push({
      id: 'profile-target-role',
      statement: `用户当前目标岗位方向：${seed.targetRole.trim()}`,
      sourceType: 'profile',
      sourceLabel: '简历 / 偏好配置 · 目标岗位方向',
      sourceCity: null,
      polarity: 'support',
      weight: 0.55,
      borrowed: false,
      borrowingReason: null,
      notApplicableTo: ['不能单独证明市场可达级别或薪资区间'],
    });
  }
  if (seed.resumeText.trim() !== '') {
    evidence.push({
      id: 'profile-resume',
      statement: '已保存简历正文，可作为能力与经历抽取的候选输入。',
      sourceType: 'resume',
      sourceLabel: '简历 / 偏好配置 · 简历正文',
      sourceCity: null,
      polarity: 'support',
      weight: 0.6,
      borrowed: false,
      borrowingReason: null,
      notApplicableTo: ['未经逐项确认前不能视为已验证能力'],
    });
  }
  if (seed.projectExperience.trim() !== '') {
    evidence.push({
      id: 'profile-projects',
      statement: '已保存项目经历，可用于形成跨城市复用的交付能力候选证据。',
      sourceType: 'project',
      sourceLabel: '简历 / 偏好配置 · 项目经历',
      sourceCity: null,
      polarity: 'support',
      weight: 0.65,
      borrowed: false,
      borrowingReason: null,
      notApplicableTo: ['不能直接推导任一城市的薪资、供给或转化'],
    });
  }
  return evidence;
}

function makeBand(
  label: JobMatchBand['label'],
  role: string,
  expectedSalary: string,
  citySpecific: boolean,
): JobMatchBand {
  const labelText = label === 'stretch' ? '冲刺' : label === 'focus' ? '主攻' : '稳妥';
  return {
    label,
    roles: [`${role || '待填写岗位方向'}（${labelText}）`],
    salaryRange: citySpecific
      ? '待结合本城市独立证据确认'
      : expectedSalary || '由四城市视图分别维护',
    companyRange: ['待结合团队规模、业务类型与用工方式确认'],
    notes: ['这是 G1 探索性草案，不构成正式降薪、降级或转岗结论。'],
  };
}

function makeView(
  scope: JobMatchCityCode,
  seed: JobMatchProfileSeed,
  supportEvidence: JobMatchEvidence[],
): JobMatchProfileView {
  const cityNames: Record<JobMatchCityCode, string> = {
    global: '全局',
    suzhou: '苏州',
    wuxi: '无锡',
    shanghai: '上海',
    hangzhou: '杭州',
  };
  const citySpecific = scope !== 'global';
  const role = seed.targetRole.trim() || '产品型前端 / AI 应用工程化方向';
  const weakness = seed.weaknessNote.trim();
  const counterEvidence: JobMatchEvidence[] = weakness === ''
    ? []
    : [{
        id: `profile-weakness-${scope}`,
        statement: weakness,
        sourceType: 'profile',
        sourceLabel: '简历 / 偏好配置 · 个人短板说明',
        sourceCity: null,
        polarity: 'counter',
        weight: 0.45,
        borrowed: false,
        borrowingReason: null,
        notApplicableTo: ['需要结合真实招聘反馈判断影响范围'],
      }];

  return {
    scope,
    headline: `${cityNames[scope]}岗位匹配画像 · 待审核草案`,
    corePositioning: role,
    highestReachableRole: '待结合已确认能力证据与真实招聘反馈验证',
    stretch: makeBand('stretch', role, seed.expectedSalary.trim(), citySpecific),
    focus: makeBand('focus', role, seed.expectedSalary.trim(), citySpecific),
    safe: makeBand('safe', role, seed.expectedSalary.trim(), citySpecific),
    strengths: supportEvidence.length > 0
      ? ['已有简历与项目输入，可继续拆解为可验证优势。']
      : ['尚未形成已确认优势，请先补充简历、项目或人工证据。'],
    capabilitiesToValidate: [
      '目标岗位所需能力是否有可回溯项目证据',
      '招聘反馈能否验证岗位级别与职责边界',
    ],
    constraints: weakness === ''
      ? ['尚未录入明确限制，不能据此假设没有限制。']
      : [weakness],
    idealEnvironment: ['业务目标清晰、允许前端参与产品与 AI 应用闭环的自研团队'],
    acceptableRange: [
      citySpecific
        ? '薪资、供给、学历门槛、公司偏好和渠道表现仅使用本城市证据'
        : '四城市分别维护市场边界，全局只复用能力与项目事实',
    ],
    supportEvidence,
    counterEvidence,
    biggestUncertainties: [
      citySpecific
        ? `${cityNames[scope]}当前有效样本是否足以形成可行动结论`
        : '跨城市可复用能力尚未完成逐项确认',
      '最高可达岗位仍缺少直接、可归因的招聘反馈',
    ],
    confidenceState: supportEvidence.length > 0 ? 'exploratory' : 'insufficient',
    confidenceReason: supportEvidence.length > 0
      ? '已有个人资料输入，但缺少经过审核的能力证据与本城市市场样本。'
      : '当前缺少足以支撑岗位定位的个人资料与市场反馈。',
    blockedConclusions: [
      '禁止据此正式降薪、降级或下调长期定位',
      '禁止把一个城市的薪资、转化或供给直接复制到另一个城市',
    ],
  };
}

export function createManualJobMatchProfileDraft(seed: JobMatchProfileSeed): JobMatchProfileDraft {
  const supportEvidence = evidenceFromSeed(seed);
  return JobMatchProfileDraftSchema.parse({
    schemaVersion: 1,
    title: '全局岗位匹配画像',
    summary: '基于当前 Profile 建立的 G1 探索性草案；需经用户审核后才会成为正式版本。',
    global: makeView('global', seed, supportEvidence),
    suzhou: makeView('suzhou', seed, supportEvidence),
    wuxi: makeView('wuxi', seed, supportEvidence),
    shanghai: makeView('shanghai', seed, supportEvidence),
    hangzhou: makeView('hangzhou', seed, supportEvidence),
  });
}

export function addJobMatchProfileProposal(
  current: JobMatchProfileState,
  input: CreateProposalInput,
): { state: JobMatchProfileState; proposal: JobMatchProfileProposal } {
  const state = JobMatchProfileStateSchema.parse(current);
  if (state.proposals.some((item) => item.id === input.id)) {
    throw new Error(`岗位画像提案已存在: ${input.id}`);
  }
  const proposal = JobMatchProfileProposalSchema.parse({
    id: input.id,
    source: input.source,
    status: 'proposed',
    createdAt: input.createdAt,
    draft: input.draft,
    decision: null,
    aiRun: input.aiRun ?? null,
  });
  const next = JobMatchProfileStateSchema.parse({
    ...state,
    stateVersion: state.stateVersion + 1,
    proposals: [proposal, ...state.proposals],
  });
  return { state: next, proposal };
}

export function decideJobMatchProfileProposal(
  current: JobMatchProfileState,
  input: DecideProposalInput,
): JobMatchProfileState {
  const state = JobMatchProfileStateSchema.parse(current);
  const proposal = state.proposals.find((item) => item.id === input.proposalId);
  if (!proposal) throw new Error(`岗位画像提案不存在: ${input.proposalId}`);
  if (proposal.status !== 'proposed' && proposal.status !== 'deferred') {
    throw new Error('只有待审核或稍后处理的提案可以再次决议');
  }

  if (input.action === 'reject' || input.action === 'defer') {
    const action = input.action === 'reject' ? 'rejected' : 'deferred';
    return JobMatchProfileStateSchema.parse({
      ...state,
      stateVersion: state.stateVersion + 1,
      proposals: state.proposals.map((item) => item.id === proposal.id
        ? {
            ...item,
            status: action,
            decision: {
              action,
              note: input.note ?? '',
              decidedAt: input.now,
              deferredUntil: input.action === 'defer' ? input.deferredUntil ?? null : null,
            },
          }
        : item),
    });
  }

  const draft = input.action === 'modify_and_accept'
    ? JobMatchProfileDraftSchema.parse(input.modifiedDraft)
    : proposal.draft;
  const versionId = input.versionId?.trim();
  if (!versionId) throw new Error('接受提案时必须提供新版本 ID');
  if (state.versions.some((item) => item.id === versionId)) {
    throw new Error(`岗位画像版本已存在: ${versionId}`);
  }
  const versionNumber = state.versions.reduce(
    (max, item) => Math.max(max, item.versionNumber),
    0,
  ) + 1;
  const decisionAction = input.action === 'modify_and_accept'
    ? 'modified_and_accepted'
    : 'accepted';
  const version = JobMatchProfileVersionSchema.parse({
    id: versionId,
    versionNumber,
    createdAt: input.now,
    activatedAt: input.now,
    sourceProposalId: proposal.id,
    supersedesVersionId: state.activeVersionId,
    changeNote: input.note ?? '',
    draft,
  });

  return JobMatchProfileStateSchema.parse({
    ...state,
    stateVersion: state.stateVersion + 1,
    activeVersionId: version.id,
    versions: [version, ...state.versions],
    proposals: state.proposals.map((item) => item.id === proposal.id
      ? {
          ...item,
          status: decisionAction,
          decision: {
            action: decisionAction,
            note: input.note ?? '',
            decidedAt: input.now,
            deferredUntil: null,
          },
        }
      : item),
  });
}

export function activateJobMatchProfileVersion(
  current: JobMatchProfileState,
  versionId: string,
  now: number,
): JobMatchProfileState {
  const state = JobMatchProfileStateSchema.parse(current);
  const version = state.versions.find((item) => item.id === versionId);
  if (!version) throw new Error(`岗位画像版本不存在: ${versionId}`);
  if (state.activeVersionId === versionId) return state;
  return JobMatchProfileStateSchema.parse({
    ...state,
    stateVersion: state.stateVersion + 1,
    activeVersionId: versionId,
    versions: state.versions.map((item) => item.id === versionId
      ? { ...item, activatedAt: now }
      : item),
  });
}

export function getActiveJobMatchProfileVersion(
  state: JobMatchProfileState,
): JobMatchProfileVersion | null {
  if (state.activeVersionId === null) return null;
  return state.versions.find((item) => item.id === state.activeVersionId) ?? null;
}

export function getJobMatchProfileView(
  draft: JobMatchProfileDraft,
  city: JobMatchCityCode,
): JobMatchProfileView {
  return draft[city];
}

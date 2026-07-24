import type { JobMatchAnalysisInputSnapshotV1 } from './contracts';
import type { JobMatchAnalysisLlmInputV1 } from './llmContracts';
import type { JobMatchAnalysisPayloadV1 } from './analysisPayload';

/** 合法完整输入快照（测试基线，可被 override 局部改写）。 */
export function validSnapshot(
  overrides: Partial<JobMatchAnalysisInputSnapshotV1> = {},
): JobMatchAnalysisInputSnapshotV1 {
  return {
    contractVersion: 1,
    candidate: {
      candidateId: 'cand-1',
      candidateVersionId: 'ver-1',
      contentHash: 'chash-1',
      normalizedFacts: {
        company: 'Acme', role: 'Backend Engineer', city: '苏州', district: null,
        salaryMinK: 20, salaryMaxK: 35, salaryPeriod: 'month',
        experienceRequirement: '3-5年', educationRequirement: '本科',
        companySize: '500-999', industry: '互联网', jobNature: '全职', workMode: 'onsite',
        technicalStack: ['Go', 'Kubernetes'],
        responsibilities: ['设计后端服务', '维护 CI/CD'],
        requirements: ['3年 Go 经验', '熟悉分布式'],
        publishedAt: 1_700_000_000, rawDescription: '岗位描述正文。',
      },
      qualityIssues: [{ field: 'salary', issue: '薪资范围较宽' }],
      sourceSnapshotIds: ['snap-1', 'snap-2'],
    },
    resume: {
      versionId: 'resume-1', contentHash: 'rhash-1',
      safeSnapshot: {
        name: '后端工程师简历', summary: '6 年后端经验，主导支付系统重构',
        resumeText: '资深后端工程师，Go 微服务与高并发实战。', projectExperience: '主导支付系统重构，QPS 提升 3 倍。',
      },
    },
    jobMatchProfile: {
      versionId: 'profile-1', contentHash: 'phash-1',
      safeSnapshot: {
        targetRoles: ['后端工程师'], coreCapabilities: ['分布式系统'],
        constraints: ['仅苏州'], preferences: ['技术驱动团队'],
      },
    },
    capabilityBaseline: null,
    marketPosition: null,
    strategy: null,
    cityContext: { cityCode: 'suzhou', usesGlobalProfile: false, missingCityEvidence: false },
    readiness: {
      hasCapabilityBaseline: false, hasMarketPosition: false, hasStrategy: false,
      confidenceCeiling: 'medium', limitations: ['缺少能力基线正式版本：结论置信度上限为 medium'],
    },
    ruleProjection: {
      version: 'rules-v1', projectionHash: 'proj-1',
      assessments: [
        { ruleKey: 'salary_floor', category: 'hard_constraint', result: 'pass', severity: 'high', explanation: '薪资达标', evidenceState: 'structured' },
        { ruleKey: 'commute', category: 'risk', result: 'hit', severity: 'medium', explanation: '通勤偏远', evidenceState: 'legacy_scalar' },
      ],
      userOverrides: [{ ruleKey: 'commute', overrideState: 'overridden_pass', note: '可接受' }],
    },
    promptVersion: 'prompt-v1',
    analysisPolicyVersion: 'policy-v1',
    providerPolicyVersion: 'provider-policy-v1',
    provider: { providerName: 'deepseek', modelName: 'deepseek-chat', modelVersion: null },
    createdAt: 1_700_000_100,
    ...overrides,
  };
}

/** 合法 LLM 输入（无内部 ID）。 */
export function validLlmInput(
  overrides: Partial<JobMatchAnalysisLlmInputV1> = {},
): JobMatchAnalysisLlmInputV1 {
  return {
    contractVersion: 1,
    promptVersion: 'prompt-v1',
    jobFacts: {
      company: 'Acme', role: 'Backend Engineer', city: '苏州', salaryText: '20-35K/月',
      experienceRequirement: '3-5年', educationRequirement: '本科', jobNature: '全职', workMode: 'onsite',
      technicalStack: ['Go', 'Kubernetes'],
      responsibilities: ['设计后端服务'], requirements: ['3年 Go 经验'],
      description: '岗位描述正文。',
    },
    person: {
      capabilities: ['Go 微服务'], experienceHighlights: ['主导支付系统重构'],
      targetRoles: ['后端工程师'], coreCapabilities: ['分布式系统'],
      constraints: ['仅苏州'], preferences: ['技术驱动团队'],
    },
    cityContext: { cityCode: 'suzhou', usesGlobalProfile: false, missingCityEvidence: false },
    ruleProjection: [
      { ruleKey: 'salary_floor', category: 'hard_constraint', result: 'pass', severity: 'high', explanation: '薪资达标' },
    ],
    evidenceCatalog: [
      {
        evidenceKey: 'candidate:requirement:1', kind: 'candidate_fact', label: '岗位要求',
        statement: '3年 Go 经验', polarity: 'neutral', strength: 'medium', sourcePath: 'requirements[0]',
      },
    ],
    ...overrides,
  };
}

/** 合法完整分析输出 Payload。 */
export function validPayload(
  overrides: Partial<JobMatchAnalysisPayloadV1> = {},
): JobMatchAnalysisPayloadV1 {
  const point = (statement: string, evidenceKeys: string[]): JobMatchAnalysisPayloadV1['gaps'][number] => ({
    statement, kind: 'fact', evidenceKeys, explanation: '说明', impact: 'positive', severity: 'low', confidence: 'medium',
  });
  const dim = (): JobMatchAnalysisPayloadV1['dimensions']['roleFit'] => ({
    summary: '维度小结', assessment: 'moderate', points: [point('结论', ['candidate:requirement:1'])],
  });
  return {
    contractVersion: 1,
    jobFacts: [{ statement: '岗位在苏州', kind: 'fact', evidenceKeys: ['candidate:requirement:1'] }],
    dimensions: {
      roleFit: dim(), capabilityFit: dim(), businessAndCompanyFit: dim(), cityAndSalaryFit: dim(),
    },
    transferableEvidence: [point('可迁移能力', ['candidate:requirement:1'])],
    gaps: [point('缺口', ['candidate:requirement:1'])],
    risks: [point('风险', ['candidate:requirement:1'])],
    counterEvidence: [point('反证', ['candidate:requirement:1'])],
    uncertainties: [{ statement: '不确定项', kind: 'unknown', evidenceKeys: [], explanation: '缺少市场数据', impact: 'unknown', severity: 'none', confidence: 'low' }],
    missingEvidence: ['缺少最近项目细节'],
    hardConstraints: [{ statement: '硬约束满足', kind: 'rule_result', evidenceKeys: ['candidate:requirement:1'], explanation: '规则通过', impact: 'positive', severity: 'none', confidence: 'high' }],
    recommendation: 'apply_now',
    confidence: 'high',
    summary: '整体匹配良好。',
    recruiterQuestions: ['团队规模多大？'],
    communicationAngles: ['强调分布式经验'],
    ...overrides,
  };
}

export const ALLOWED_KEYS: ReadonlySet<string> = new Set(['candidate:requirement:1']);

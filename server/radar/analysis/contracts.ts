/**
 * V8-4 服务端持久化输入快照契约 `JobMatchAnalysisInputSnapshotV1`。
 *
 * 这是**服务端 Envelope 层**快照（写入 analysis_tasks.input_snapshot_json），
 * 允许持有内部数据库 ID（candidateId/versionId 等）用于审计与幂等，
 * 但必须严格、有限、可序列化：全部 strictObject、无 z.unknown()、数组/字符串有上限、
 * 总序列化 ≤ 128KB、canonical JSON 序列化、超限抛明确契约错误。
 *
 * 本波次不从数据库组装快照——只固定契约与 parse/serialize。safeSnapshot 是**有限投影**，
 * 不允许把 Resume/Profile 等完整领域对象直接塞入。
 */
import { z } from 'zod';
import { canonicalJson } from '../../job-memory/requestHash';
import { AnalysisContractError } from './contractErrors';
import { scanForbiddenContent } from './safetyScan';

export const ANALYSIS_INPUT_SNAPSHOT_CONTRACT_VERSION = 1;
export const SNAPSHOT_MAX_BYTES = 128 * 1024;

const SHORT_TEXT = 200;
const MEDIUM_TEXT = 500;
/** Candidate rawDescription 不得无上限进入快照：截断投影上限。 */
const RAW_DESCRIPTION_MAX = 8_000;
const LIST_MAX = 60;
const ID = z.string().trim().min(1).max(120);
const HASH = z.string().trim().min(1).max(128);
const VERSION = z.string().trim().min(1).max(80);

const bounded = (max: number) => z.string().max(max);

/** 候选岗位标准化事实的**有限投影**（对齐 RadarCandidateNormalized，字段全部显式）。 */
export const CandidateFactsSchema = z.strictObject({
  company: bounded(SHORT_TEXT).nullable(),
  role: bounded(SHORT_TEXT).nullable(),
  city: bounded(SHORT_TEXT).nullable(),
  district: bounded(SHORT_TEXT).nullable(),
  salaryMinK: z.number().finite().nullable(),
  salaryMaxK: z.number().finite().nullable(),
  salaryPeriod: bounded(SHORT_TEXT).nullable(),
  experienceRequirement: bounded(SHORT_TEXT).nullable(),
  educationRequirement: bounded(SHORT_TEXT).nullable(),
  companySize: bounded(SHORT_TEXT).nullable(),
  industry: bounded(SHORT_TEXT).nullable(),
  jobNature: bounded(SHORT_TEXT).nullable(),
  workMode: bounded(SHORT_TEXT).nullable(),
  technicalStack: z.array(bounded(SHORT_TEXT)).max(LIST_MAX),
  responsibilities: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  requirements: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  publishedAt: z.number().finite().nullable(),
  rawDescription: bounded(RAW_DESCRIPTION_MAX),
});
export type CandidateFacts = z.infer<typeof CandidateFactsSchema>;

export const QualityIssueSchema = z.strictObject({
  field: bounded(SHORT_TEXT),
  issue: bounded(MEDIUM_TEXT),
});

/** 简历版本正文投影上限：截断，绝不无上限带入完整简历。 */
const RESUME_TEXT_MAX = 8_000;

/**
 * 简历脱敏投影：对齐真实 ResumeVersionRecord（name/summary + contentSnapshot 正文）。
 * 上一波的 headline/yearsOfExperience/capabilities 等结构化字段真实简历并不存在（简历为自由文本），
 * 为「只映射真实正式数据」按 §三 做最小契约调整：只承载真实存在的四个字段（正文截断）。
 */
export const ResumeSafeSnapshotSchema = z.strictObject({
  name: bounded(SHORT_TEXT).nullable(),
  summary: bounded(MEDIUM_TEXT).nullable(),
  resumeText: bounded(RESUME_TEXT_MAX),
  projectExperience: bounded(RESUME_TEXT_MAX),
});

/** 正式画像脱敏投影。 */
export const JobMatchProfileSafeSnapshotSchema = z.strictObject({
  targetRoles: z.array(bounded(SHORT_TEXT)).max(LIST_MAX),
  coreCapabilities: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  constraints: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  preferences: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
});

export const CapabilitySafeSnapshotSchema = z.strictObject({
  strengths: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  gaps: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
});

export const MarketSafeSnapshotSchema = z.strictObject({
  positioning: bounded(MEDIUM_TEXT).nullable(),
  competitiveFactors: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
});

export const StrategySafeSnapshotSchema = z.strictObject({
  focus: bounded(MEDIUM_TEXT).nullable(),
  tactics: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
});

/** 可选上下文版本包装（版本 + 内容 hash + 脱敏投影）。 */
const optionalContext = <T extends z.ZodTypeAny>(safe: T) =>
  z
    .strictObject({ versionId: ID, contentHash: HASH, safeSnapshot: safe })
    .nullable();

/**
 * 规则投影单项（脱敏，语义键回指见 evidenceCatalog；此处仅承载投影事实）。
 * evidenceState 显式标记证据载体状态：structured(合法 evidence_json)/legacy_scalar(NULL 回退 scalar)/
 * corrupt(非 NULL 但校验失败)——corrupt 明确标记，绝不静默忽略（对齐 §六 与 ruleEvidenceService 语义）。
 */
export const RuleProjectionItemSchema = z.strictObject({
  ruleKey: bounded(SHORT_TEXT),
  category: z.enum(['hard_constraint', 'risk', 'preference', 'state_suppression']),
  result: z.enum(['hit', 'pass', 'unknown']),
  severity: bounded(SHORT_TEXT),
  explanation: bounded(MEDIUM_TEXT),
  evidenceState: z.enum(['structured', 'legacy_scalar', 'corrupt']),
});

export const RuleOverrideProjectionSchema = z.strictObject({
  ruleKey: bounded(SHORT_TEXT),
  overrideState: z.enum(['overridden_pass', 'overridden_block', 'override_reverted']),
  note: bounded(MEDIUM_TEXT).nullable(),
});

/**
 * 输入就绪度与局限（§四）。本波次不调用模型，仅在快照中如实记录：
 * - hasCapabilityBaseline/hasMarketPosition/hasStrategy：对应正式版本是否存在；
 * - confidenceCeiling：能力基线缺失 → 结论置信度上限降为 medium，否则 high；
 * - limitations：缺失/借用（如非目标城市走全局画像）导致的确定性局限说明（供执行波次消费，不发模型）。
 */
export const AnalysisReadinessSchema = z.strictObject({
  hasCapabilityBaseline: z.boolean(),
  hasMarketPosition: z.boolean(),
  hasStrategy: z.boolean(),
  confidenceCeiling: z.enum(['low', 'medium', 'high']),
  limitations: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
});

export const JobMatchAnalysisInputSnapshotV1Schema = z.strictObject({
  contractVersion: z.literal(ANALYSIS_INPUT_SNAPSHOT_CONTRACT_VERSION),
  candidate: z.strictObject({
    candidateId: ID,
    candidateVersionId: ID,
    contentHash: HASH,
    normalizedFacts: CandidateFactsSchema,
    qualityIssues: z.array(QualityIssueSchema).max(LIST_MAX),
    sourceSnapshotIds: z.array(ID).max(LIST_MAX),
  }),
  resume: z.strictObject({ versionId: ID, contentHash: HASH, safeSnapshot: ResumeSafeSnapshotSchema }),
  jobMatchProfile: z.strictObject({ versionId: ID, contentHash: HASH, safeSnapshot: JobMatchProfileSafeSnapshotSchema }),
  capabilityBaseline: optionalContext(CapabilitySafeSnapshotSchema),
  marketPosition: optionalContext(MarketSafeSnapshotSchema),
  strategy: optionalContext(StrategySafeSnapshotSchema),
  cityContext: z.strictObject({
    cityCode: bounded(SHORT_TEXT).nullable(),
    usesGlobalProfile: z.boolean(),
    missingCityEvidence: z.boolean(),
  }),
  readiness: AnalysisReadinessSchema,
  ruleProjection: z.strictObject({
    version: VERSION,
    projectionHash: HASH,
    assessments: z.array(RuleProjectionItemSchema).max(LIST_MAX),
    userOverrides: z.array(RuleOverrideProjectionSchema).max(LIST_MAX),
  }),
  promptVersion: VERSION,
  analysisPolicyVersion: VERSION,
  providerPolicyVersion: VERSION,
  provider: z.strictObject({
    providerName: bounded(SHORT_TEXT),
    modelName: bounded(SHORT_TEXT),
    modelVersion: bounded(SHORT_TEXT).nullable(),
  }),
  /**
   * 人工恢复链（可选）：仅在为一个 failed 任务新建「人工恢复任务」时写入。
   * of = 前序任务 id（被恢复的那个）；generation = 恢复代次（1 起）。
   * 该字段纳入 inputHash（仅 createdAt 被剔除）→ 天然派生出与前序不同的 taskId，
   * 从而在不改表结构、不重置旧任务 attempt 的前提下新建关联任务。仅审计/派生用，
   * 不进 LLM 输入（llmInput 白名单不含该字段）。缺省不写 → 旧快照照常解析。
   */
  recovery: z
    .strictObject({
      of: ID,
      generation: z.number().int().positive(),
    })
    .optional(),
  createdAt: z.number().finite().nonnegative(),
});

export type JobMatchAnalysisInputSnapshotV1 = z.infer<typeof JobMatchAnalysisInputSnapshotV1Schema>;

/** 去重并限量 sourceSnapshotIds（稳定顺序）。 */
export function dedupeSourceSnapshotIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].slice(0, LIST_MAX);
}

/**
 * 严格解析快照对象：Zod strict → 敏感内容扫描 → 字节上限。
 * 快照允许内部 ID，故不扫内部 ID 泄漏；但仍禁止 Cookie/Token/HTML/绝对路径。
 */
export function parseJobMatchAnalysisInputSnapshot(value: unknown): JobMatchAnalysisInputSnapshotV1 {
  const result = JobMatchAnalysisInputSnapshotV1Schema.safeParse(value);
  if (!result.success) {
    throw new AnalysisContractError('SNAPSHOT_INVALID', '输入快照未通过契约校验', result.error.issues[0]?.path.join('.'));
  }
  const forbidden = scanForbiddenContent(result.data);
  if (forbidden.length > 0) {
    throw new AnalysisContractError('SNAPSHOT_INVALID', '输入快照包含禁止内容（凭证/HTML/路径等）', forbidden[0]?.path);
  }
  const text = canonicalJson(result.data);
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > SNAPSHOT_MAX_BYTES) {
    throw new AnalysisContractError('SNAPSHOT_TOO_LARGE', `输入快照超过 ${SNAPSHOT_MAX_BYTES} 字节（实际 ${bytes}）`);
  }
  return result.data;
}

/** 校验并 canonical 序列化快照（写入前用）；超限抛错，绝不写入非法快照。 */
export function serializeJobMatchAnalysisInputSnapshot(snapshot: unknown): string {
  const parsed = parseJobMatchAnalysisInputSnapshot(snapshot);
  return canonicalJson(parsed);
}

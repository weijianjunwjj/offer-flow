/**
 * V8-4 严格分析输出契约 `JobMatchAnalysisPayloadV1` + 解析与交叉验证。
 *
 * 这是发给用户的唯一正式分析结果契约（写入 job_match_analysis_records.payload_json）。
 * 全部 strictObject；数组/文本有上限；JSON ≤ 32KB；无 Markdown/HTML；无百分制 matchScore；
 * 无内部数据库 ID；事实/推断类结论必须引用 evidenceKey；unknown/missing 可不引用但须说明缺失原因；
 * missing 不得表达为负面事实；hardConstraints.kind 仅 fact/rule_result/unknown。
 */
import { z } from 'zod';
import { AnalysisContractError } from './contractErrors';
import { EVIDENCE_KEY_PATTERN } from './evidenceCatalog';
import { scanForbiddenContent, scanHtml, scanInternalIdLeak } from './safetyScan';

export const ANALYSIS_PAYLOAD_CONTRACT_VERSION = 1;
export const PAYLOAD_MAX_BYTES = 32 * 1024;

const STATEMENT_MAX = 500;
const EXPLANATION_MAX = 800;
const SUMMARY_MAX = 1_200;
const LINE_MAX = 200;
const POINTS_MAX = 24;
const LIST_MAX = 24;
const EVIDENCE_REFS_MAX = 12;

const evidenceKey = z.string().regex(EVIDENCE_KEY_PATTERN, '结论引用了非法 evidenceKey');

export const ANALYSIS_POINT_KINDS = ['fact', 'inference', 'user_preference', 'rule_result', 'unknown'] as const;
export type AnalysisPointKind = (typeof ANALYSIS_POINT_KINDS)[number];

/**
 * 基础结论点。约束：
 * - 非 unknown 的结论必须至少引用一个 evidenceKey；
 * - unknown 结论可不引用证据，但 explanation 必须非空（说明缺失原因）；
 * - impact=negative 且无证据 → 视为把 missing 伪装成负面事实，拒绝。
 */
export const AnalysisPointSchema = z
  .strictObject({
    statement: z.string().min(1).max(STATEMENT_MAX),
    kind: z.enum(ANALYSIS_POINT_KINDS),
    evidenceKeys: z.array(evidenceKey).max(EVIDENCE_REFS_MAX),
    explanation: z.string().min(1).max(EXPLANATION_MAX),
    impact: z.enum(['positive', 'negative', 'mixed', 'unknown']),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'none']),
    confidence: z.enum(['low', 'medium', 'high']),
  })
  .superRefine((point, ctx) => {
    if (point.kind !== 'unknown' && point.evidenceKeys.length === 0) {
      ctx.addIssue({ code: 'custom', message: `${point.kind} 结论必须至少引用一个 evidenceKey` });
    }
    // missing ≠ negative：无证据支撑的负面断言不允许（unknown 只能中性/未知影响）。
    if (point.kind === 'unknown' && point.impact === 'negative') {
      ctx.addIssue({ code: 'custom', message: 'unknown 结论不得表达为负面事实（missing≠negative）' });
    }
  });
export type AnalysisPoint = z.infer<typeof AnalysisPointSchema>;

/** hardConstraints 结论：kind 仅 fact/rule_result/unknown。 */
const HardConstraintPointSchema = AnalysisPointSchema.superRefine((point, ctx) => {
  if (!['fact', 'rule_result', 'unknown'].includes(point.kind)) {
    ctx.addIssue({ code: 'custom', message: 'hardConstraints 的 kind 只能是 fact/rule_result/unknown' });
  }
});

export const MatchDimensionSchema = z.strictObject({
  summary: z.string().min(1).max(SUMMARY_MAX),
  assessment: z.enum(['strong', 'moderate', 'weak', 'unknown']),
  points: z.array(AnalysisPointSchema).max(POINTS_MAX),
});
export type MatchDimension = z.infer<typeof MatchDimensionSchema>;

const JobFactSchema = z.strictObject({
  statement: z.string().min(1).max(STATEMENT_MAX),
  kind: z.enum(ANALYSIS_POINT_KINDS),
  evidenceKeys: z.array(evidenceKey).max(EVIDENCE_REFS_MAX),
});

const boundedLine = z.string().min(1).max(LINE_MAX);

export const JobMatchAnalysisPayloadV1Schema = z.strictObject({
  contractVersion: z.literal(ANALYSIS_PAYLOAD_CONTRACT_VERSION),
  jobFacts: z.array(JobFactSchema).max(POINTS_MAX),
  dimensions: z.strictObject({
    roleFit: MatchDimensionSchema,
    capabilityFit: MatchDimensionSchema,
    businessAndCompanyFit: MatchDimensionSchema,
    cityAndSalaryFit: MatchDimensionSchema,
  }),
  transferableEvidence: z.array(AnalysisPointSchema).max(POINTS_MAX),
  gaps: z.array(AnalysisPointSchema).max(POINTS_MAX),
  risks: z.array(AnalysisPointSchema).max(POINTS_MAX),
  counterEvidence: z.array(AnalysisPointSchema).max(POINTS_MAX),
  uncertainties: z.array(AnalysisPointSchema).max(POINTS_MAX),
  missingEvidence: z.array(boundedLine).max(LIST_MAX),
  hardConstraints: z.array(HardConstraintPointSchema).max(POINTS_MAX),
  recommendation: z.enum(['apply_now', 'stretch', 'verify', 'skip']),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: z.string().min(1).max(SUMMARY_MAX),
  recruiterQuestions: z.array(boundedLine).max(LIST_MAX),
  communicationAngles: z.array(boundedLine).max(LIST_MAX),
});
export type JobMatchAnalysisPayloadV1 = z.infer<typeof JobMatchAnalysisPayloadV1Schema>;

/** 收集 payload 内全部被引用的 evidenceKey（用于交叉验证）。 */
export function collectReferencedEvidenceKeys(payload: JobMatchAnalysisPayloadV1): string[] {
  const keys: string[] = [];
  const pushPoints = (points: { evidenceKeys: string[] }[]) => {
    for (const p of points) keys.push(...p.evidenceKeys);
  };
  for (const fact of payload.jobFacts) keys.push(...fact.evidenceKeys);
  for (const dim of Object.values(payload.dimensions)) pushPoints(dim.points);
  pushPoints(payload.transferableEvidence);
  pushPoints(payload.gaps);
  pushPoints(payload.risks);
  pushPoints(payload.counterEvidence);
  pushPoints(payload.uncertainties);
  pushPoints(payload.hardConstraints);
  return keys;
}

/**
 * 从 rawText 提取单个 JSON 对象。兼容最外层 ```json fence，但拒绝 Markdown 正文：
 * fence 前后有正文、或裸文本不以 { 开头，一律 ANALYSIS_JSON_INVALID。
 */
function extractJsonObjectText(rawText: string): string {
  const trimmed = rawText.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  if (fence !== null) return fence[1]!.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  throw new AnalysisContractError('ANALYSIS_JSON_INVALID', '响应不是单个 JSON 对象（含 Markdown 正文或非法包裹）');
}

/**
 * 解析并交叉验证模型分析输出。流程：
 * 提取单 JSON → 字节上限 → JSON.parse → Zod strict → 无 Markdown/HTML → 无内部 ID →
 * 无敏感内容 → 全部 evidenceKeys ∈ allowedEvidenceKeys。任一失败抛分类契约错误。
 *
 * 错误信息只含稳定语义与字段路径，**不回显 rawText 全文**。
 */
export function parseJobMatchAnalysisPayload(
  rawText: string,
  allowedEvidenceKeys: ReadonlySet<string>,
): JobMatchAnalysisPayloadV1 {
  const jsonText = extractJsonObjectText(rawText);

  const bytes = Buffer.byteLength(jsonText, 'utf8');
  if (bytes > PAYLOAD_MAX_BYTES) {
    throw new AnalysisContractError('ANALYSIS_PAYLOAD_TOO_LARGE', `分析结果超过 ${PAYLOAD_MAX_BYTES} 字节（实际 ${bytes}）`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw new AnalysisContractError('ANALYSIS_JSON_INVALID', `分析结果不是合法 JSON：${(error as Error).message}`);
  }

  // 提前拒绝百分制匹配分等禁用字段：strictObject 已拒绝未知字段，这里给出明确信号。
  const result = JobMatchAnalysisPayloadV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new AnalysisContractError('ANALYSIS_SCHEMA_INVALID', '分析结果未通过契约校验', result.error.issues[0]?.path.join('.'));
  }
  const payload = result.data;

  const html = scanHtml(payload);
  if (html.length > 0) {
    throw new AnalysisContractError('ANALYSIS_HTML_NOT_ALLOWED', '分析结果包含 HTML', html[0]?.path);
  }
  const idLeak = scanInternalIdLeak(payload);
  if (idLeak.length > 0) {
    throw new AnalysisContractError('ANALYSIS_INTERNAL_ID_LEAK', '分析结果包含内部数据库 ID', idLeak[0]?.path);
  }
  const forbidden = scanForbiddenContent(payload);
  if (forbidden.length > 0) {
    throw new AnalysisContractError('ANALYSIS_SENSITIVE_CONTENT', '分析结果包含敏感内容（凭证/路径等）', forbidden[0]?.path);
  }

  for (const key of collectReferencedEvidenceKeys(payload)) {
    if (!allowedEvidenceKeys.has(key)) {
      throw new AnalysisContractError('ANALYSIS_UNKNOWN_EVIDENCE_KEY', `分析结果引用了目录外的 evidenceKey：${key}`, key);
    }
  }

  return payload;
}

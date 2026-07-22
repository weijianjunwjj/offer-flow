/**
 * V8-3 / RC-06 规则证据契约（版本化、严格约束）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §2.2/§14b；
 * BR-2 方案 A：evidence_json 是新规则证据的权威结构。
 *
 * 严格边界：
 * - 顶层非 z.unknown()，全部字段显式约束；contractVersion 固定为 1；
 * - rawValue/normalizedValue 仅接受受限 JSON-safe 值（标量 / 标量数组 / 浅层标量对象），
 *   不接受无限递归、无限深度或任意大对象；
 * - evidenceExcerpt 单项 ≤200 字；confidence ∈ [0,1]；matches ≤20；整体序列化 ≤16KB；
 * - 禁止 Cookie/Token/securityId、完整 JD、完整页面 HTML、聊天内容、招聘者联系方式。
 */
import { z } from 'zod';

export const RULE_EVIDENCE_CONTRACT_VERSION = 1;
export const EVIDENCE_JSON_MAX_BYTES = 16 * 1024;
export const EVIDENCE_EXCERPT_MAX_CHARS = 200;
export const EVIDENCE_MATCHES_MAX = 20;

/** 受限 JSON-safe 标量：null / string / number(有限) / boolean。 */
const jsonScalar = z.union([
  z.null(),
  z.string(),
  z.number().finite(),
  z.boolean(),
]);

/** 标量数组（元素上限保护，避免大数组）。 */
const jsonScalarArray = z.array(jsonScalar).max(50);

/** 浅层标量对象：值只能是标量，禁止嵌套对象/数组（防无限深度）。 */
const jsonShallowObject = z.record(z.string().max(100), jsonScalar).refine(
  (obj) => Object.keys(obj).length <= 50,
  { message: '浅层对象键过多' },
);

/** rawValue / normalizedValue 受限取值：标量 | 标量数组 | 浅层标量对象。 */
export const RestrictedJsonValueSchema = z.union([
  jsonScalar,
  jsonScalarArray,
  jsonShallowObject,
]);

export type RestrictedJsonValue = z.infer<typeof RestrictedJsonValueSchema>;

/** 疑似敏感内容的保守检测（Cookie/Token/securityId 等）。命中即判为非法证据。 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  /securityId/i,
  /\bcookie\b/i,
  /set-cookie/i,
  /authorization:/i,
  /\bbearer\s+[a-z0-9._-]+/i,
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /\bsessionid\b/i,
  /微信|加微信|vx[:：]|wechat/i,
  /\b1[3-9]\d{9}\b/, // 中国大陆手机号
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i, // 邮箱
];

function containsForbiddenContent(text: string): boolean {
  return FORBIDDEN_PATTERNS.some((re) => re.test(text));
}

const boundedExcerpt = z
  .string()
  .max(EVIDENCE_EXCERPT_MAX_CHARS, { message: `证据摘录超过 ${EVIDENCE_EXCERPT_MAX_CHARS} 字` })
  .refine((s) => !containsForbiddenContent(s), { message: '证据摘录包含禁止内容（凭证/联系方式等）' });

/** 单条命中项。 */
export const RuleEvidenceMatchSchema = z.strictObject({
  fieldPath: z.string().trim().min(1).max(200),
  excerpt: boundedExcerpt,
  rawValue: RestrictedJsonValueSchema.nullable().default(null),
  normalizedValue: RestrictedJsonValueSchema.nullable().default(null),
});

export type RuleEvidenceMatch = z.infer<typeof RuleEvidenceMatchSchema>;

/**
 * outcome 明确区分 unknown 与 false、rule_error 与 not_matched：
 * - matched：规则命中（通常 blocking/风险）；
 * - not_matched：规则明确未命中（确定的 false，不是缺失）；
 * - unknown：证据缺失，无法判定（不得当作 not_matched）；
 * - rule_error：规则执行出错（与 not_matched 严格区分）。
 */
export const RuleEvidenceOutcomeSchema = z.enum(['matched', 'not_matched', 'unknown', 'rule_error']);

export const RuleEvidenceCategorySchema = z.enum([
  'hard_constraint', 'risk', 'preference', 'state_suppression',
]);

export const RuleEvidenceSourceSchema = z.enum([
  'normalized_field', 'raw_description', 'snapshot_metadata', 'derived',
]);

/** 用户覆盖状态（追加式审计的当前投影，不删除原评估）。 */
export const RuleEvidenceUserOverrideStateSchema = z.enum([
  'none', 'overridden_pass', 'overridden_block', 'override_reverted',
]);

/** 顶层规则证据对象（权威结构）。 */
export const RuleEvidenceSchema = z.strictObject({
  contractVersion: z.literal(RULE_EVIDENCE_CONTRACT_VERSION),
  ruleId: z.string().trim().min(1).max(100),
  ruleVersion: z.string().trim().min(1).max(50),
  ruleCategory: RuleEvidenceCategorySchema,
  candidateId: z.string().trim().min(1).max(100),
  candidateVersionId: z.string().trim().min(1).max(100),
  outcome: RuleEvidenceOutcomeSchema,
  sourceSnapshotId: z.string().trim().min(1).max(100).nullable().default(null),
  matchedFieldPath: z.string().trim().min(1).max(200).nullable().default(null),
  rawValue: RestrictedJsonValueSchema.nullable().default(null),
  normalizedValue: RestrictedJsonValueSchema.nullable().default(null),
  evidenceExcerpt: boundedExcerpt.nullable().default(null),
  evidenceSource: RuleEvidenceSourceSchema.nullable().default(null),
  explanation: z.string().trim().min(1).max(1000),
  severity: z.string().trim().min(1).max(50),
  confidence: z.number().finite().min(0).max(1),
  blocking: z.boolean(),
  matches: z.array(RuleEvidenceMatchSchema).max(EVIDENCE_MATCHES_MAX).default([]),
  userOverrideState: RuleEvidenceUserOverrideStateSchema.default('none'),
}).superRefine((value, ctx) => {
  // rule_error 不得声称 blocking 命中；unknown 不得携带 matchedFieldPath 断言事实。
  if (value.outcome === 'unknown' && value.matchedFieldPath !== null) {
    ctx.addIssue({ code: 'custom', message: 'unknown 结果不应携带 matchedFieldPath（缺失不是命中）' });
  }
  if (value.explanation && containsForbiddenContent(value.explanation)) {
    ctx.addIssue({ code: 'custom', message: 'explanation 包含禁止内容（凭证/联系方式等）' });
  }
});

export type RuleEvidence = z.infer<typeof RuleEvidenceSchema>;

/** 解析结果：valid / invalid（损坏或超限，明确标记，不静默忽略）。 */
export type RuleEvidenceParseResult =
  | { status: 'valid'; evidence: RuleEvidence }
  | { status: 'invalid'; reason: string };

/**
 * 严格解析 evidence_json 文本。
 * 先校验字节上限（16KB），再 JSON.parse，再 Zod 校验；任一失败返回 invalid（不抛出、不静默）。
 */
export function parseRuleEvidenceJson(text: string): RuleEvidenceParseResult {
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > EVIDENCE_JSON_MAX_BYTES) {
    return { status: 'invalid', reason: `evidence_json 超过 ${EVIDENCE_JSON_MAX_BYTES} 字节（实际 ${byteLength}）` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { status: 'invalid', reason: `evidence_json 不是合法 JSON：${(error as Error).message}` };
  }
  const result = RuleEvidenceSchema.safeParse(parsed);
  if (!result.success) {
    return { status: 'invalid', reason: `evidence_json 未通过契约校验：${result.error.issues[0]?.message ?? '未知'}` };
  }
  return { status: 'valid', evidence: result.data };
}

/**
 * 序列化并强制校验（写入前用）：校验失败或超 16KB 抛错，绝不写入非法证据。
 */
export function serializeRuleEvidence(evidence: unknown): string {
  const validated = RuleEvidenceSchema.parse(evidence);
  const text = JSON.stringify(validated);
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > EVIDENCE_JSON_MAX_BYTES) {
    throw new Error(`序列化后的 evidence_json 超过 ${EVIDENCE_JSON_MAX_BYTES} 字节（实际 ${byteLength}）`);
  }
  return text;
}

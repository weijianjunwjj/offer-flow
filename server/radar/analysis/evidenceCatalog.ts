/**
 * V8-4 证据目录 `EvidenceCatalogV1`。
 *
 * 证据目录是发给模型的证据集合，evidenceKey 是**稳定语义键**（非数据库 ID），
 * 模型输出通过 evidenceKey 回指目录。服务端持有 key→内部对象的私有映射（不发给模型）。
 *
 * 稳定性策略（对齐设计 §2.2 与本波次要求）：
 * - 集合型字段（technicalStack 等）：先规范化 + 稳定排序，序号不随输入顺序漂移；
 * - 业务顺序字段（responsibilities/requirements）：保留业务顺序，用规范化内容的短指纹
 *   作为键主体，相同内容得相同指纹；同指纹重复时追加稳定序号消歧；
 * - 相同固定输入 → 相同 evidenceKey；重排集合不产生不必要的 key 漂移。
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AnalysisContractError } from './contractErrors';

export const EVIDENCE_MAX_ITEMS = 100;
export const EVIDENCE_LABEL_MAX = 200;
export const EVIDENCE_STATEMENT_MAX = 500;
export const EVIDENCE_SOURCE_PATH_MAX = 200;

export const EVIDENCE_KINDS = [
  'candidate_fact',
  'resume_fact',
  'profile_preference',
  'capability_evidence',
  'market_evidence',
  'strategy_evidence',
  'rule_result',
  'unknown',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * evidenceKey 语法：`<namespace>:<kind>[:<seq-or-fingerprint>]`
 * - namespace/kind：小写字母与连字符；
 * - 第三段可选：数字序号，或 8 位十六进制短指纹（+可选 -数字消歧）。
 * 例：candidate:responsibility:1a2b3c4d、candidate:salary、rule:risk:2。
 */
export const EVIDENCE_KEY_PATTERN = /^[a-z]+(?:-[a-z]+)*:[a-z]+(?:-[a-z]+)*(?::(?:[0-9]+|[0-9a-f]{8}(?:-[0-9]+)?))?$/;

export const AnalysisEvidenceItemSchema = z.strictObject({
  evidenceKey: z.string().regex(EVIDENCE_KEY_PATTERN, 'evidenceKey 不是合法稳定语义键'),
  kind: z.enum(EVIDENCE_KINDS),
  label: z.string().min(1).max(EVIDENCE_LABEL_MAX),
  statement: z.string().min(1).max(EVIDENCE_STATEMENT_MAX),
  polarity: z.enum(['support', 'counter', 'neutral']),
  strength: z.enum(['strong', 'medium', 'weak', 'unknown']),
  sourcePath: z.string().min(1).max(EVIDENCE_SOURCE_PATH_MAX),
});
export type AnalysisEvidenceItem = z.infer<typeof AnalysisEvidenceItemSchema>;

export const EvidenceCatalogV1Schema = z
  .array(AnalysisEvidenceItemSchema)
  .max(EVIDENCE_MAX_ITEMS)
  .superRefine((items, ctx) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.evidenceKey)) {
        ctx.addIssue({ code: 'custom', message: `evidenceKey 重复：${item.evidenceKey}` });
      }
      seen.add(item.evidenceKey);
    }
  });
export type EvidenceCatalogV1 = z.infer<typeof EvidenceCatalogV1Schema>;

/** 规范化文本：trim + 折叠内部空白（保留大小写），用于稳定指纹与排序。 */
export function normalizeEvidenceText(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

/** 8 位十六进制短指纹（规范化内容 → sha256 前 8 位）。相同内容得相同指纹。 */
export function evidenceFingerprint(text: string): string {
  return createHash('sha256').update(normalizeEvidenceText(text)).digest('hex').slice(0, 8);
}

/**
 * 业务顺序字段（保留业务序）→ 稳定 key 列表。
 * 键主体用规范化内容短指纹；同指纹重复时追加 `-n`（按业务顺序 1,2,...）消歧，
 * 因此重排不影响未重复内容的 key，仅在真正同内容重复时才有序号。
 */
export function buildOrderedKeys(namespace: string, kind: string, texts: readonly string[]): string[] {
  const counts = new Map<string, number>();
  return texts.map((text) => {
    const fp = evidenceFingerprint(text);
    const n = (counts.get(fp) ?? 0) + 1;
    counts.set(fp, n);
    return n === 1 ? `${namespace}:${kind}:${fp}` : `${namespace}:${kind}:${fp}-${n}`;
  });
}

/**
 * 集合型字段（无业务序）→ 稳定 key 列表。先规范化 + 稳定排序（去重后），
 * 序号按排序后位置 1..n，因此输入顺序变化不影响结果 key。
 */
export function buildSetKeys(namespace: string, kind: string, texts: readonly string[]): string[] {
  const unique = [...new Set(texts.map(normalizeEvidenceText))].sort((a, b) => a.localeCompare(b));
  return unique.map((_, index) => `${namespace}:${kind}:${index + 1}`);
}

/** 目录的 evidenceKey 集合（供交叉验证模型输出引用）。 */
export function collectEvidenceKeys(catalog: EvidenceCatalogV1): Set<string> {
  return new Set(catalog.map((item) => item.evidenceKey));
}

/** 严格校验目录（结构 + 唯一 + 数量）。返回校验后的目录，失败抛契约错误。 */
export function parseEvidenceCatalog(value: unknown): EvidenceCatalogV1 {
  const result = EvidenceCatalogV1Schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const tooMany = issue?.code === 'too_big';
    const dup = issue?.message.includes('重复');
    const code = tooMany ? 'EVIDENCE_TOO_MANY' : dup ? 'EVIDENCE_DUPLICATE_KEY' : 'EVIDENCE_KEY_INVALID';
    throw new AnalysisContractError(code, issue?.message ?? '证据目录校验失败', issue?.path.join('.'));
  }
  return result.data;
}

/**
 * 交叉验证模型输出引用的 evidenceKeys 是否全部存在于目录。
 * 任一未知 key 立即抛 ANALYSIS_UNKNOWN_EVIDENCE_KEY——不静默删除未知引用。
 */
export function assertEvidenceKeysKnown(
  keys: readonly string[],
  allowed: ReadonlySet<string>,
): void {
  for (const key of keys) {
    if (!allowed.has(key)) {
      throw new AnalysisContractError('ANALYSIS_UNKNOWN_EVIDENCE_KEY', `模型引用了目录外的 evidenceKey：${key}`, key);
    }
  }
}

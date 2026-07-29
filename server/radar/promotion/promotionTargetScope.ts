/**
 * V8-6 第一波 · 目标正式对象范围键（`targetScopeKey`）。
 *
 * TD §13.4 要求 idempotency_key 至少含 candidate_version_id、promotion_type
 * 与**目标正式对象范围**。本模块负责最后一项。
 *
 * 关键约束：范围键必须**与"关联既有 Job 还是新建 Job"无关**。
 * 若直接用 jobId，首次晋升（尚无 Job，只能填 null）与重放（已有 Job）
 * 会算出不同键，幂等立即失效。因此改用候选版本的规范化业务身份
 * （公司 / 岗位 / 城市），它在两种路径下恒定。
 */
import { sha256RequestHash } from '../../job-memory/requestHash';

export const TARGET_SCOPE_PREFIX = 'radar-promotion-scope:v1';

export interface PromotionTargetScopeInput {
  company: string | null;
  role: string | null;
  city: string | null;
}

/** 规范化：trim + 小写 + 空串归一为 null，避免大小写/空白造成键漂移。 */
function normalizeToken(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed === '' ? null : trimmed;
}

/**
 * 由候选版本的规范化身份派生范围键。
 *
 * 显式接受"三者全为 null"：此时同一候选版本的所有晋升归入同一范围，
 * 幂等仍由 candidateVersionId + depth 保证（宁可偏保守地复用，
 * 也不要因身份缺失而写出重复正式对象）。
 */
export function computeTargetScopeKey(input: PromotionTargetScopeInput): string {
  const digest = sha256RequestHash({
    company: normalizeToken(input.company),
    role: normalizeToken(input.role),
    city: normalizeToken(input.city),
  });
  return `${TARGET_SCOPE_PREFIX}:${digest}`;
}

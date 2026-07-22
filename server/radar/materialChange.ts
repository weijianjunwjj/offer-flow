/**
 * V8-3 material change 分类（字段级变化判定）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §6/§6.5。
 *
 * 严格边界：
 * - 只比较 §6 B 类实质字段；C 类快照字段（capturedAt/活跃度/confidence/rawDescription 原文）不参与；
 * - unknown→确定值：material（新版本）；
 * - 确定值→unknown：默认采集质量退化（extraction_regression），只留 Snapshot、不建版本；
 * - 确定值 A→确定值 B：material；
 * - 数组按规范化集合比较（顺序不敏感），复用 fingerprint 的集合语义；
 * - fingerprint 相同 → no_change。
 */
import type { RadarCandidateNormalized } from '../../src/domain/radar';
import { buildMaterialPayload, computeCandidateFingerprint, type MaterialPayload } from './candidateFingerprint';

export type ChangeClassification =
  | 'no_change'
  | 'material_change'
  | 'extraction_regression';

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
  /** unknown_to_known | known_to_unknown | value_changed */
  kind: 'unknown_to_known' | 'known_to_unknown' | 'value_changed';
}

export interface MaterialChangeResult {
  classification: ChangeClassification;
  changedFields: FieldChange[];
  /** 是否应创建新的 CandidateVersion。 */
  shouldCreateVersion: boolean;
  /** 是否为采集质量退化（确定值→unknown 主导且无正向变化）。 */
  isRegression: boolean;
  /** 变化后的 fingerprint（供落库比较）。 */
  fingerprint: string;
}

const SCALAR_FIELDS: Array<keyof MaterialPayload> = [
  'company', 'role', 'city', 'district', 'salaryMinK', 'salaryMaxK',
  'salaryPeriod', 'experienceRequirement', 'educationRequirement', 'jobNature', 'companySize',
];
const ARRAY_FIELDS: Array<keyof MaterialPayload> = ['responsibilities', 'requirements', 'technicalStack'];

function isEmpty(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/**
 * 比较旧/新 normalized 事实，产出字段级变化集合与决策。
 * @param previous 旧版本 normalized（首个版本时传 null）。
 */
export function classifyMaterialChange(
  previous: RadarCandidateNormalized | null,
  next: RadarCandidateNormalized,
): MaterialChangeResult {
  const fingerprint = computeCandidateFingerprint(next);

  if (previous === null) {
    // 首个版本：一律 material（建首版）。
    return { classification: 'material_change', changedFields: [], shouldCreateVersion: true, isRegression: false, fingerprint };
  }

  const prevPayload = buildMaterialPayload(previous);
  const nextPayload = buildMaterialPayload(next);
  const changedFields: FieldChange[] = [];

  for (const field of SCALAR_FIELDS) {
    const before = prevPayload[field];
    const after = nextPayload[field];
    if (before === after) continue;
    changedFields.push({ field, before, after, kind: changeKind(before, after) });
  }
  for (const field of ARRAY_FIELDS) {
    const before = prevPayload[field] as string[];
    const after = nextPayload[field] as string[];
    if (arraysEqual(before, after)) continue;
    changedFields.push({ field, before, after, kind: changeKind(before, after) });
  }

  if (changedFields.length === 0) {
    return { classification: 'no_change', changedFields, shouldCreateVersion: false, isRegression: false, fingerprint };
  }

  // 退化判定：存在 known→unknown，且不存在任何正向变化（unknown→known 或 value_changed）。
  const hasRegression = changedFields.some((c) => c.kind === 'known_to_unknown');
  const hasForward = changedFields.some((c) => c.kind === 'unknown_to_known' || c.kind === 'value_changed');
  if (hasRegression && !hasForward) {
    return { classification: 'extraction_regression', changedFields, shouldCreateVersion: false, isRegression: true, fingerprint };
  }

  return { classification: 'material_change', changedFields, shouldCreateVersion: true, isRegression: false, fingerprint };
}

function changeKind(before: unknown, after: unknown): FieldChange['kind'] {
  const beforeEmpty = isEmpty(before);
  const afterEmpty = isEmpty(after);
  if (beforeEmpty && !afterEmpty) return 'unknown_to_known';
  if (!beforeEmpty && afterEmpty) return 'known_to_unknown';
  return 'value_changed';
}

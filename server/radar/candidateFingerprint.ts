/**
 * V8-3 no-change fingerprint v1（材料字段指纹）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §7。
 *
 * 严格边界：
 * - 前缀 "radar-candidate-version:v1" 参与 hash，隔离算法升级；
 * - 只包含规范化后的实质事实字段（§7.2），身份字段不入；
 * - responsibilities/requirements/technicalStack 按规范化集合比较（§7.3），顺序不敏感；
 * - 明确排除 capturedAt/活跃度/confidence/metadata/rawDescription 原文（§7.1）；
 * - null/unknown/empty 表达固定；不直接对整个 normalized 对象 hash。
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../job-memory/requestHash';
import type { RadarCandidateNormalized } from '../../src/domain/radar';
import { canonicalStringSet } from './fieldNormalization';

export const FINGERPRINT_PREFIX = 'radar-candidate-version:v1';

/**
 * 材料 payload：仅 §7.2 实质字段，数组按集合规范化。
 * 注意：rawDescription 原文不进入（只用其派生的 responsibilities/requirements）。
 */
export interface MaterialPayload {
  company: string | null;
  role: string | null;
  city: string | null;
  district: string | null;
  salaryMinK: number | null;
  salaryMaxK: number | null;
  salaryPeriod: string | null;
  experienceRequirement: string | null;
  educationRequirement: string | null;
  jobNature: string | null;
  companySize: string | null;
  responsibilities: string[];
  requirements: string[];
  technicalStack: string[];
}

/** 从 normalized 事实抽取材料 payload（数组重新集合规范化以保证顺序不敏感）。 */
export function buildMaterialPayload(normalized: RadarCandidateNormalized): MaterialPayload {
  return {
    company: emptyToNull(normalized.company),
    role: emptyToNull(normalized.role),
    city: emptyToNull(normalized.city),
    district: emptyToNull(normalized.district),
    salaryMinK: normalized.salaryMinK,
    salaryMaxK: normalized.salaryMaxK,
    salaryPeriod: emptyToNull(normalized.salaryPeriod),
    experienceRequirement: emptyToNull(normalized.experienceRequirement),
    educationRequirement: emptyToNull(normalized.educationRequirement),
    jobNature: emptyToNull(normalized.jobNature),
    companySize: emptyToNull(normalized.companySize),
    responsibilities: canonicalStringSet(normalized.responsibilities),
    requirements: canonicalStringSet(normalized.requirements),
    technicalStack: canonicalStringSet(normalized.technicalStack),
  };
}

function emptyToNull(value: string | null): string | null {
  if (value === null) return null;
  return value.length === 0 ? null : value;
}

/**
 * 计算 fingerprint v1（严格按 §7.5 公式）：
 * sha256(prefix + "\n" + canonicalJson(materialPayload))，
 * canonicalJson 递归按 key 排序、拒绝 undefined/非有限数（复用 requestHash 的 canonical 语义）。
 */
export function computeCandidateFingerprint(normalized: RadarCandidateNormalized): string {
  const payload = buildMaterialPayload(normalized);
  const input = `${FINGERPRINT_PREFIX}\n${canonicalJson(payload)}`;
  return createHash('sha256').update(input).digest('hex');
}

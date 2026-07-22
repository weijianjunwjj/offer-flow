/**
 * V8-3 确定性字段标准化（无推断、无 LLM）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §2/§3。
 *
 * 严格边界：
 * - 缺失字段保持 unknown（null），不猜测；
 * - 冲突或不可安全解析保持 ambiguous（值置 null + 记 quality issue）；
 * - missing 不得变成 negative；
 * - 只做 trim / 空白折叠 / 明确枚举归一 / 明确区间解析；
 * - 原始值始终保留在 Snapshot，本模块产出不覆盖 raw evidence。
 */
import type { RadarCandidateNormalized, RadarCandidateQualityIssue } from '../../src/domain/radar';
import type { RadarCaptureRecognizedFields } from './dtoSchemas';

/** 每个字段的分类：已知 / 缺失未知 / 冲突或不可判定。 */
export type FieldClassification = 'known' | 'unknown' | 'ambiguous';

export interface FieldNormalizationResult {
  normalized: RadarCandidateNormalized;
  qualityIssues: RadarCandidateQualityIssue[];
  /** 需人工确认的字段（ambiguous）。 */
  ambiguousFields: string[];
}

/** 折叠内部连续空白为单个空格，统一换行/零宽字符，并 trim。 */
export function collapseWhitespace(value: string): string {
  return value
    .replace(/​|﻿|‌|‍/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n+ */g, '\n')
    .trim();
}

/** trim + 折叠空白；空串归一为 null。不做任何推断。 */
export function cleanScalar(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = collapseWhitespace(value);
  return cleaned.length === 0 ? null : cleaned;
}

/** 逐项 trim/折叠、去空、去重、稳定排序（用于 fingerprint 的集合语义字段）。 */
export function canonicalStringSet(values: readonly string[] | null | undefined): string[] {
  if (values === null || values === undefined) return [];
  const seen = new Set<string>();
  for (const raw of values) {
    const cleaned = stripListItemPrefix(cleanScalar(raw));
    if (cleaned !== null) seen.add(cleaned);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** 去除纯编号/项目符号前缀（1. / 1、 / ① / - / • / * 等），不改变正文语义。 */
export function stripListItemPrefix(value: string | null): string | null {
  if (value === null) return null;
  const stripped = value
    .replace(/^\s*(?:[-*•·]|\d+[.、)]|[①②③④⑤⑥⑦⑧⑨⑩]|[（(]\d+[）)])\s*/u, '')
    .trim();
  return stripped.length === 0 ? null : stripped;
}

const SALARY_PERIOD_MAP: Record<string, string> = {
  月: 'month', '月薪': 'month', month: 'month', monthly: 'month', '/月': 'month',
  年: 'year', '年薪': 'year', year: 'year', annual: 'year', yearly: 'year', '/年': 'year',
  日: 'day', '日薪': 'day', day: 'day', daily: 'day', '/日': 'day', '天': 'day',
};

/** 枚举归一化，命中返回 canonical 值，否则 null（不猜测）。 */
export function normalizeSalaryPeriod(value: string | null): string | null {
  const cleaned = cleanScalar(value);
  if (cleaned === null) return null;
  return SALARY_PERIOD_MAP[cleaned.toLowerCase()] ?? SALARY_PERIOD_MAP[cleaned] ?? null;
}

export interface NormalizeInput {
  recognizedFields: RadarCaptureRecognizedFields | null;
  rawDescription: string;
  /** 已在上层从 extractionMetadata 受控提升的结构字段（仅明确可解析项）。 */
  liftedFields?: {
    district?: string | null;
    responsibilities?: string[] | null;
    requirements?: string[] | null;
    technicalStack?: string[] | null;
  };
}

/**
 * 确定性标准化：清理 → 解析 → canonical → 冲突检测 → 分类。
 * 返回 normalized 事实、quality issues 与需人工确认的 ambiguous 字段。
 */
export function normalizeCandidateFields(input: NormalizeInput): FieldNormalizationResult {
  const rf = input.recognizedFields;
  const lifted = input.liftedFields ?? {};
  const qualityIssues: RadarCandidateQualityIssue[] = [];
  const ambiguousFields: string[] = [];

  const addIssue = (field: string, issue: string): void => {
    qualityIssues.push({ field, issue });
  };
  const markAmbiguous = (field: string, issue: string): void => {
    addIssue(field, issue);
    if (!ambiguousFields.includes(field)) ambiguousFields.push(field);
  };

  const company = cleanScalar(rf?.company ?? null);
  const role = cleanScalar(rf?.role ?? null);
  const city = cleanScalar(rf?.city ?? null);
  const district = cleanScalar(lifted.district ?? null);

  // 冲突：company 与 role 完全相等 → 极可能字段串位，两者都不可信。
  let resolvedCompany = company;
  let resolvedRole = role;
  if (company !== null && role !== null && company === role) {
    markAmbiguous('company', 'company 与 role 相等，疑似字段串位');
    markAmbiguous('role', 'company 与 role 相等，疑似字段串位');
    resolvedCompany = null;
    resolvedRole = null;
  }

  // 薪资：区间解析 + 冲突检测（min > max）。不推断单位。
  let salaryMinK = rf?.salaryMinK ?? null;
  let salaryMaxK = rf?.salaryMaxK ?? null;
  if (salaryMinK !== null && salaryMaxK !== null && salaryMinK > salaryMaxK) {
    markAmbiguous('salaryMinK', 'salaryMinK 大于 salaryMaxK，区间不合法');
    markAmbiguous('salaryMaxK', 'salaryMinK 大于 salaryMaxK，区间不合法');
    salaryMinK = null;
    salaryMaxK = null;
  }

  const salaryPeriodRaw = cleanScalar(rf?.salaryPeriod ?? null);
  let salaryPeriod = normalizeSalaryPeriod(salaryPeriodRaw);
  if (salaryPeriodRaw !== null && salaryPeriod === null) {
    // 有原始值但无法安全归一 → ambiguous，不猜测。
    markAmbiguous('salaryPeriod', `salaryPeriod 无法归一化：${salaryPeriodRaw}`);
  }
  // 有薪资区间但周期缺失：保持 unknown（不默认月薪，避免把 missing 当成事实）。

  const experienceRequirement = cleanScalar(rf?.experienceRequirement ?? null);
  const educationRequirement = cleanScalar(rf?.educationRequirement ?? null);

  const normalized: RadarCandidateNormalized = {
    company: resolvedCompany,
    role: resolvedRole,
    city,
    district,
    salaryMinK,
    salaryMaxK,
    salaryPeriod,
    experienceRequirement,
    educationRequirement,
    // 以下字段 V8-3 暂无确定来源（V8-2 恒空），保持 unknown，不推断：
    companySize: null,
    industry: null,
    jobNature: null,
    workMode: null,
    technicalStack: canonicalStringSet(lifted.technicalStack ?? null),
    responsibilities: canonicalStringSet(lifted.responsibilities ?? null),
    requirements: canonicalStringSet(lifted.requirements ?? null),
    publishedAt: null,
    rawDescription: input.rawDescription,
  };

  return { normalized, qualityIssues, ambiguousFields };
}

/** 判定单个字段分类，供上层展示与测试。 */
export function classifyField(value: unknown, isAmbiguous: boolean): FieldClassification {
  if (isAmbiguous) return 'ambiguous';
  if (value === null || (Array.isArray(value) && value.length === 0)) return 'unknown';
  return 'known';
}

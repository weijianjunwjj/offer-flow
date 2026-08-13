/**
 * v0.9 Phase 5A — Evidence Upgrade 内容哈希测试。
 *
 * 覆盖：
 *   - 前缀参与哈希（与 material fingerprint 隔离）
 *   - 复用 canonicalJson（key 顺序不敏感）
 *   - 完整 normalized（含 rawDescription）参与哈希
 *   - rawDescription 变化 → hash 变化；结构化事实变化 → hash 变化
 */

import { describe, expect, it } from 'vitest';
import type { RadarCandidateNormalized } from '../../../src/domain/radar';
import { computeCandidateFingerprint } from '../candidateFingerprint';
import { computeEvidenceUpgradeContentHash } from './evidenceUpgradeHash';

function makeNormalized(overrides: Partial<RadarCandidateNormalized> = {}): RadarCandidateNormalized {
  return {
    company: '某科技公司',
    role: '高级前端开发工程师',
    city: '苏州',
    district: null,
    salaryMinK: 20,
    salaryMaxK: 30,
    salaryPeriod: '月薪',
    experienceRequirement: '3-5年',
    educationRequirement: '本科',
    companySize: null,
    industry: null,
    jobNature: null,
    workMode: null,
    technicalStack: ['React', 'TypeScript'],
    responsibilities: ['负责Web前端开发'],
    requirements: ['3年以上经验'],
    publishedAt: null,
    rawDescription: '搜索摘要片段',
    ...overrides,
  };
}

describe('computeEvidenceUpgradeContentHash', () => {
  it('对同一对象稳定、key 顺序不敏感', () => {
    const a = makeNormalized();
    const b = makeNormalized({ role: a.role, rawDescription: a.rawDescription });
    // 构造 key 顺序不同的等价对象
    const reordered: RadarCandidateNormalized = {
      rawDescription: b.rawDescription,
      role: b.role,
      company: b.company,
      city: b.city,
      district: b.district,
      salaryMinK: b.salaryMinK,
      salaryMaxK: b.salaryMaxK,
      salaryPeriod: b.salaryPeriod,
      experienceRequirement: b.experienceRequirement,
      educationRequirement: b.educationRequirement,
      companySize: b.companySize,
      industry: b.industry,
      jobNature: b.jobNature,
      workMode: b.workMode,
      technicalStack: b.technicalStack,
      responsibilities: b.responsibilities,
      requirements: b.requirements,
      publishedAt: b.publishedAt,
    };
    expect(computeEvidenceUpgradeContentHash(a)).toBe(computeEvidenceUpgradeContentHash(reordered));
  });

  it('rawDescription 参与哈希：仅 rawDescription 变化时 upgrade hash 改变', () => {
    const snippet = makeNormalized({ rawDescription: '搜索摘要片段' });
    const full = makeNormalized({ rawDescription: '完整岗位正文（含职责、要求、薪资等全部事实）' });

    expect(computeEvidenceUpgradeContentHash(snippet)).not.toBe(computeEvidenceUpgradeContentHash(full));
    // material fingerprint 排除 rawDescription，故保持不变
    expect(computeCandidateFingerprint(snippet)).toBe(computeCandidateFingerprint(full));
  });

  it('结构化事实变化时 hash 改变', () => {
    const a = makeNormalized();
    const b = makeNormalized({ role: '后端工程师' });
    expect(computeEvidenceUpgradeContentHash(a)).not.toBe(computeEvidenceUpgradeContentHash(b));
  });

  it('与 material fingerprint 是不同语义（同输入产出不同 hash）', () => {
    const n = makeNormalized();
    expect(computeEvidenceUpgradeContentHash(n)).not.toBe(computeCandidateFingerprint(n));
  });
});

/**
 * v0.9 P0.1 — evidence-state content hash 纯函数测试。
 */
import { describe, expect, it } from 'vitest';
import { computeEvidenceStateContentHash, evidenceRank } from './evidenceStateHash';
import type { RadarCandidateNormalized } from '../../src/domain/radar';

function norm(role: string): RadarCandidateNormalized {
  return {
    company: null, role, city: null, district: null,
    salaryMinK: null, salaryMaxK: null, salaryPeriod: null,
    experienceRequirement: null, educationRequirement: null,
    companySize: null, industry: null, jobNature: null, workMode: null,
    technicalStack: [], responsibilities: [], requirements: [],
    publishedAt: null, rawDescription: 'JD',
  };
}

describe('computeEvidenceStateContentHash', () => {
  it('同材料同 evidence → 稳定', () => {
    expect(computeEvidenceStateContentHash(norm('前端工程师'), 'SEARCH_EVIDENCE'))
      .toBe(computeEvidenceStateContentHash(norm('前端工程师'), 'SEARCH_EVIDENCE'));
  });

  it('同材料不同 evidence → 不同 hash（evidence 维度隔离）', () => {
    expect(computeEvidenceStateContentHash(norm('前端工程师'), 'SEARCH_EVIDENCE'))
      .not.toBe(computeEvidenceStateContentHash(norm('前端工程师'), 'MANUAL_REVIEW_REQUIRED'));
  });

  it('不同材料 → 不同 hash', () => {
    expect(computeEvidenceStateContentHash(norm('前端工程师'), 'SEARCH_EVIDENCE'))
      .not.toBe(computeEvidenceStateContentHash(norm('后端工程师'), 'SEARCH_EVIDENCE'));
  });

  it('输出为 64 位 hex（sha256）', () => {
    expect(computeEvidenceStateContentHash(norm('前端工程师'), 'SEARCH_EVIDENCE'))
      .toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('evidenceRank', () => {
  it('MRR < SEARCH < FULL', () => {
    expect(evidenceRank('MANUAL_REVIEW_REQUIRED')).toBeLessThan(evidenceRank('SEARCH_EVIDENCE'));
    expect(evidenceRank('SEARCH_EVIDENCE')).toBeLessThan(evidenceRank('FULL_EVIDENCE'));
  });
});

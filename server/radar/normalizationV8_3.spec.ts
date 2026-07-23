import { describe, it, expect } from 'vitest';
import type { RadarCandidateNormalized, RadarSourceRecord } from '../../src/domain/radar';
import {
  cleanScalar,
  canonicalStringSet,
  stripListItemPrefix,
  normalizeSalaryPeriod,
  normalizeCandidateFields,
  classifyField,
} from './fieldNormalization';
import { canonicalizeSourceUrl } from './canonicalUrl';
import { computeCandidateFingerprint, buildMaterialPayload, FINGERPRINT_PREFIX } from './candidateFingerprint';
import { resolveIdentity, type IdentityLookups } from './identityResolution';
import { classifyMaterialChange } from './materialChange';

function emptyNormalized(overrides: Partial<RadarCandidateNormalized> = {}): RadarCandidateNormalized {
  return {
    company: null, role: null, city: null, district: null, salaryMinK: null, salaryMaxK: null,
    salaryPeriod: null, experienceRequirement: null, educationRequirement: null, companySize: null,
    industry: null, jobNature: null, workMode: null, technicalStack: [], responsibilities: [],
    requirements: [], publishedAt: null, rawDescription: '', ...overrides,
  };
}

describe('fieldNormalization: scalar cleaning', () => {
  it('trims and collapses internal whitespace', () => {
    expect(cleanScalar('  前端   工程师  ')).toBe('前端 工程师');
    expect(cleanScalar('a\n\nb')).toBe('a\nb');
  });
  it('maps empty/whitespace-only to null (missing stays unknown, not negative)', () => {
    expect(cleanScalar('   ')).toBeNull();
    expect(cleanScalar('')).toBeNull();
    expect(cleanScalar(null)).toBeNull();
    expect(cleanScalar(undefined)).toBeNull();
  });
});

describe('fieldNormalization: list item prefix + set canonicalization', () => {
  it('strips numbering / bullet prefixes without altering meaning', () => {
    expect(stripListItemPrefix('1. 负责前端开发')).toBe('负责前端开发');
    expect(stripListItemPrefix('① 熟悉 Vue')).toBe('熟悉 Vue');
    expect(stripListItemPrefix('- 精通 TS')).toBe('精通 TS');
  });
  it('dedups and stably sorts (order-insensitive set)', () => {
    expect(canonicalStringSet(['Vue', 'React', 'Vue', ' React '])).toEqual(['React', 'Vue']);
    expect(canonicalStringSet(['React', 'Vue'])).toEqual(canonicalStringSet(['Vue', 'React']));
  });
  it('returns empty array for null/undefined', () => {
    expect(canonicalStringSet(null)).toEqual([]);
    expect(canonicalStringSet(undefined)).toEqual([]);
  });
});

describe('fieldNormalization: salary period enum (no guessing)', () => {
  it('normalizes known period tokens', () => {
    expect(normalizeSalaryPeriod('月')).toBe('month');
    expect(normalizeSalaryPeriod('年薪')).toBe('year');
    expect(normalizeSalaryPeriod('DAY')).toBe('day');
  });
  it('returns null for unknown tokens (does not guess)', () => {
    expect(normalizeSalaryPeriod('每周')).toBeNull();
    expect(normalizeSalaryPeriod(null)).toBeNull();
  });
});

describe('normalizeCandidateFields: conflict + unknown handling', () => {
  it('keeps missing fields as unknown (null), never invents values', () => {
    const r = normalizeCandidateFields({ recognizedFields: null, rawDescription: 'jd' });
    expect(r.normalized.company).toBeNull();
    expect(r.normalized.role).toBeNull();
    expect(r.normalized.salaryMinK).toBeNull();
    expect(r.normalized.rawDescription).toBe('jd');
    expect(r.ambiguousFields).toEqual([]);
  });

  it('flags company==role as ambiguous field collision and nulls both', () => {
    const r = normalizeCandidateFields({
      recognizedFields: {
        company: '前端工程师', role: '前端工程师', city: null,
        salaryMinK: null, salaryMaxK: null, salaryPeriod: null,
        experienceRequirement: null, educationRequirement: null,
      },
      rawDescription: 'jd',
    });
    expect(r.normalized.company).toBeNull();
    expect(r.normalized.role).toBeNull();
    expect(r.ambiguousFields).toContain('company');
    expect(r.ambiguousFields).toContain('role');
  });

  it('flags salaryMin>Max as ambiguous and nulls the range', () => {
    const r = normalizeCandidateFields({
      recognizedFields: {
        company: 'A', role: 'B', city: null,
        salaryMinK: 30, salaryMaxK: 20, salaryPeriod: '月',
        experienceRequirement: null, educationRequirement: null,
      },
      rawDescription: 'jd',
    });
    expect(r.normalized.salaryMinK).toBeNull();
    expect(r.normalized.salaryMaxK).toBeNull();
    expect(r.ambiguousFields).toContain('salaryMinK');
    expect(r.normalized.salaryPeriod).toBe('month');
  });

  it('flags un-normalizable salaryPeriod as ambiguous (keeps null)', () => {
    const r = normalizeCandidateFields({
      recognizedFields: {
        company: 'A', role: 'B', city: '苏州',
        salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '每周',
        experienceRequirement: null, educationRequirement: null,
      },
      rawDescription: 'jd',
    });
    expect(r.normalized.salaryPeriod).toBeNull();
    expect(r.ambiguousFields).toContain('salaryPeriod');
  });
});

describe('classifyField', () => {
  it('distinguishes known / unknown / ambiguous', () => {
    expect(classifyField('x', false)).toBe('known');
    expect(classifyField(null, false)).toBe('unknown');
    expect(classifyField([], false)).toBe('unknown');
    expect(classifyField('x', true)).toBe('ambiguous');
  });
});

describe('canonicalizeSourceUrl: provider-aware identity', () => {
  it('strips dynamic query / securityId and yields detail identity url', () => {
    const r = canonicalizeSourceUrl('https://www.zhipin.com/job_detail/abc-123.html?securityId=XYZ&lid=abc&ka=x');
    expect(r.usableForIdentity).toBe(true);
    expect(r.providerKey).toBe('boss');
    expect(r.canonicalUrl).toBe('https://www.zhipin.com/job_detail/abc-123');
    expect(r.canonicalUrl).not.toContain('securityId');
  });
  it('rejects search / list / recommend pages for identity', () => {
    expect(canonicalizeSourceUrl('https://www.zhipin.com/web/geek/jobs?query=fe').usableForIdentity).toBe(false);
    expect(canonicalizeSourceUrl('https://www.zhipin.com/job_recommend/list').usableForIdentity).toBe(false);
  });
  it('rejects unknown providers for identity but still returns display canonical', () => {
    const r = canonicalizeSourceUrl('https://example.com/jobs/1?x=1');
    expect(r.usableForIdentity).toBe(false);
    expect(r.providerKey).toBeNull();
    expect(r.canonicalUrl).toBe('https://example.com/jobs/1');
  });
  it('handles null / unparsable input safely', () => {
    expect(canonicalizeSourceUrl(null).usableForIdentity).toBe(false);
    expect(canonicalizeSourceUrl('not a url').usableForIdentity).toBe(false);
  });
});

describe('candidateFingerprint v1', () => {
  it('is insensitive to array order (set semantics)', () => {
    const a = emptyNormalized({ technicalStack: ['Vue', 'React'], responsibilities: ['x', 'y'] });
    const b = emptyNormalized({ technicalStack: ['React', 'Vue'], responsibilities: ['y', 'x'] });
    expect(computeCandidateFingerprint(a)).toBe(computeCandidateFingerprint(b));
  });
  it('is insensitive to rawDescription formatting (not in material payload)', () => {
    const a = emptyNormalized({ role: '前端', rawDescription: 'line1\nline2' });
    const b = emptyNormalized({ role: '前端', rawDescription: 'totally different jd text' });
    expect(computeCandidateFingerprint(a)).toBe(computeCandidateFingerprint(b));
  });
  it('is sensitive to a material field change', () => {
    const a = emptyNormalized({ salaryMinK: 15 });
    const b = emptyNormalized({ salaryMinK: 16 });
    expect(computeCandidateFingerprint(a)).not.toBe(computeCandidateFingerprint(b));
  });
  it('is sensitive to array content add/remove', () => {
    const a = emptyNormalized({ requirements: ['本科'] });
    const b = emptyNormalized({ requirements: ['本科', '3年经验'] });
    expect(computeCandidateFingerprint(a)).not.toBe(computeCandidateFingerprint(b));
  });
  it('material payload excludes non-material fields', () => {
    const p = buildMaterialPayload(emptyNormalized({ industry: 'IT', workMode: 'remote', publishedAt: 123 }));
    expect(p).not.toHaveProperty('industry');
    expect(p).not.toHaveProperty('workMode');
    expect(p).not.toHaveProperty('publishedAt');
    expect(p).not.toHaveProperty('rawDescription');
  });
  it('prefix participates in hash (version isolation)', () => {
    expect(FINGERPRINT_PREFIX).toBe('radar-candidate-version:v1');
  });
});

describe('resolveIdentity: conservative two-tier', () => {
  const record = (id: string): RadarSourceRecord => ({
    id, providerKey: 'boss', externalRecordId: 'ext1', normalizedSourceUrl: null,
    firstSeenAt: 1, lastSeenAt: 1, lastChangedAt: null, latestSnapshotId: 's1',
    sourceStatus: 'active', createdAt: 1, updatedAt: 1,
  });
  const noHits: IdentityLookups = { findByProviderKey: () => null, findAllByProviderAndUrl: () => [] };

  it('Tier1 hit → exact_existing', () => {
    const d = resolveIdentity({ providerKey: 'boss', externalRecordId: 'ext1', sourceUrl: null },
      { findByProviderKey: () => record('r1'), findAllByProviderAndUrl: () => [] });
    expect(d.kind).toBe('exact_existing');
    expect(d.matched?.id).toBe('r1');
  });
  it('Tier1 keys present but miss → new_source (no downgrade to Tier2)', () => {
    const d = resolveIdentity({ providerKey: 'boss', externalRecordId: 'ext1', sourceUrl: 'https://www.zhipin.com/job_detail/abc.html' }, noHits);
    expect(d.kind).toBe('new_source');
  });
  it('Tier2 single hit → exact_existing', () => {
    const d = resolveIdentity({ providerKey: 'boss', externalRecordId: null, sourceUrl: 'https://www.zhipin.com/job_detail/abc.html?securityId=x' },
      { findByProviderKey: () => null, findAllByProviderAndUrl: () => [record('r2')] });
    expect(d.kind).toBe('exact_existing');
    expect(d.matched?.id).toBe('r2');
  });
  it('Tier2 multiple hits → identity_conflict (never picks first)', () => {
    const d = resolveIdentity({ providerKey: 'boss', externalRecordId: null, sourceUrl: 'https://www.zhipin.com/job_detail/abc.html' },
      { findByProviderKey: () => null, findAllByProviderAndUrl: () => [record('r2'), record('r3')] });
    expect(d.kind).toBe('identity_conflict');
    expect(d.matched).toBeNull();
  });
  it('providerKey null → no Tier2 auto-merge, isolated new_source', () => {
    const d = resolveIdentity({ providerKey: null, externalRecordId: null, sourceUrl: 'https://www.zhipin.com/job_detail/abc.html' }, noHits);
    expect(d.kind).toBe('new_source');
    expect(d.reason).toContain('no_provider_key');
  });
  it('non-detail URL → new_source (not usable for identity)', () => {
    const d = resolveIdentity({ providerKey: 'boss', externalRecordId: null, sourceUrl: 'https://www.zhipin.com/web/geek/jobs?q=fe' }, noHits);
    expect(d.kind).toBe('new_source');
  });
});

describe('classifyMaterialChange', () => {
  it('first version → material', () => {
    const r = classifyMaterialChange(null, emptyNormalized({ role: '前端' }));
    expect(r.classification).toBe('material_change');
    expect(r.shouldCreateVersion).toBe(true);
  });
  it('identical material → no_change (rawDescription change ignored)', () => {
    const prev = emptyNormalized({ role: '前端', rawDescription: 'a' });
    const next = emptyNormalized({ role: '前端', rawDescription: 'b (reworded)' });
    const r = classifyMaterialChange(prev, next);
    expect(r.classification).toBe('no_change');
    expect(r.shouldCreateVersion).toBe(false);
  });
  it('array reorder only → no_change', () => {
    const prev = emptyNormalized({ technicalStack: ['Vue', 'React'] });
    const next = emptyNormalized({ technicalStack: ['React', 'Vue'] });
    expect(classifyMaterialChange(prev, next).classification).toBe('no_change');
  });
  it('unknown → known is material (creates version)', () => {
    const prev = emptyNormalized({ salaryMinK: null });
    const next = emptyNormalized({ salaryMinK: 15 });
    const r = classifyMaterialChange(prev, next);
    expect(r.classification).toBe('material_change');
    expect(r.changedFields[0]?.kind).toBe('unknown_to_known');
  });
  it('known → unknown is extraction_regression (no version)', () => {
    const prev = emptyNormalized({ salaryMinK: 15, salaryMaxK: 25 });
    const next = emptyNormalized({ salaryMinK: null, salaryMaxK: null });
    const r = classifyMaterialChange(prev, next);
    expect(r.classification).toBe('extraction_regression');
    expect(r.shouldCreateVersion).toBe(false);
    expect(r.isRegression).toBe(true);
  });
  it('value A → value B is material', () => {
    const prev = emptyNormalized({ city: '苏州' });
    const next = emptyNormalized({ city: '上海' });
    const r = classifyMaterialChange(prev, next);
    expect(r.classification).toBe('material_change');
    expect(r.changedFields[0]?.kind).toBe('value_changed');
  });
  it('mixed regression + forward change is material (not pure regression)', () => {
    const prev = emptyNormalized({ salaryMinK: 15, city: '苏州' });
    const next = emptyNormalized({ salaryMinK: null, city: '上海' });
    const r = classifyMaterialChange(prev, next);
    expect(r.classification).toBe('material_change');
  });
  it('array content add is material', () => {
    const prev = emptyNormalized({ requirements: ['本科'] });
    const next = emptyNormalized({ requirements: ['本科', '3年经验'] });
    expect(classifyMaterialChange(prev, next).classification).toBe('material_change');
  });
});

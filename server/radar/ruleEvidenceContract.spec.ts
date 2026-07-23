import { describe, it, expect } from 'vitest';
import {
  RULE_EVIDENCE_CONTRACT_VERSION,
  EVIDENCE_JSON_MAX_BYTES,
  RuleEvidenceSchema,
  parseRuleEvidenceJson,
  serializeRuleEvidence,
} from './ruleEvidenceContract';

function validEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: 1,
    ruleId: 'salary_floor',
    ruleVersion: 'rules-v1',
    ruleCategory: 'hard_constraint',
    candidateId: 'cand-1',
    candidateVersionId: 'ver-1',
    outcome: 'matched',
    sourceSnapshotId: 'snap-1',
    matchedFieldPath: 'salaryMinK',
    rawValue: '15',
    normalizedValue: 15,
    evidenceExcerpt: '薪资 15K 低于用户下限 20K',
    evidenceSource: 'normalized_field',
    explanation: '低于薪资下限',
    severity: 'blocking',
    confidence: 0.9,
    blocking: true,
    matches: [],
    userOverrideState: 'none',
    ...overrides,
  };
}

describe('ruleEvidenceContract: valid parsing', () => {
  it('accepts a fully valid evidence object', () => {
    const text = JSON.stringify(validEvidence());
    const r = parseRuleEvidenceJson(text);
    expect(r.status).toBe('valid');
    if (r.status === 'valid') {
      expect(r.evidence.contractVersion).toBe(RULE_EVIDENCE_CONTRACT_VERSION);
      expect(r.evidence.outcome).toBe('matched');
    }
  });

  it('serializeRuleEvidence validates and round-trips', () => {
    const text = serializeRuleEvidence(validEvidence());
    const r = parseRuleEvidenceJson(text);
    expect(r.status).toBe('valid');
  });
});

describe('ruleEvidenceContract: rejection cases', () => {
  it('rejects malformed JSON (not silently ignored)', () => {
    const r = parseRuleEvidenceJson('{not json');
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.reason).toContain('合法 JSON');
  });

  it('rejects wrong contractVersion', () => {
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ contractVersion: 2 }))).status).toBe('invalid');
  });

  it('rejects payload over 16KB', () => {
    const big = 'x'.repeat(EVIDENCE_JSON_MAX_BYTES + 100);
    // 直接构造超限文本（绕过 excerpt 上限，测字节上限本身）。
    const r = parseRuleEvidenceJson(`{"pad":"${big}"}`);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.reason).toContain('字节');
  });

  it('rejects excerpt over 200 chars', () => {
    const r = parseRuleEvidenceJson(JSON.stringify(validEvidence({ evidenceExcerpt: '啊'.repeat(201) })));
    expect(r.status).toBe('invalid');
  });

  it('rejects confidence out of [0,1]', () => {
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ confidence: 1.5 }))).status).toBe('invalid');
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ confidence: -0.1 }))).status).toBe('invalid');
  });

  it('rejects more than 20 matches', () => {
    const matches = Array.from({ length: 21 }, (_, i) => ({ fieldPath: `f${i}`, excerpt: 'x', rawValue: null, normalizedValue: null }));
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ matches }))).status).toBe('invalid');
  });

  it('rejects forbidden content (securityId / token / phone / email) in excerpt', () => {
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ evidenceExcerpt: 'securityId=abc123' }))).status).toBe('invalid');
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ evidenceExcerpt: 'access_token: xyz' }))).status).toBe('invalid');
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ evidenceExcerpt: '联系我 13800138000' }))).status).toBe('invalid');
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ evidenceExcerpt: '发邮件 hr@corp.com' }))).status).toBe('invalid');
  });

  it('rejects deeply nested rawValue (no infinite depth)', () => {
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ rawValue: { a: { b: 1 } } }))).status).toBe('invalid');
  });

  it('rejects unknown top-level keys (strictObject)', () => {
    expect(parseRuleEvidenceJson(JSON.stringify(validEvidence({ extra: 'nope' }))).status).toBe('invalid');
  });

  it('serializeRuleEvidence throws on invalid input (never writes illegal evidence)', () => {
    expect(() => serializeRuleEvidence(validEvidence({ confidence: 2 }))).toThrow();
  });
});

describe('ruleEvidenceContract: outcome semantics', () => {
  it('distinguishes unknown from not_matched', () => {
    expect(RuleEvidenceSchema.safeParse(validEvidence({ outcome: 'unknown', matchedFieldPath: null, blocking: false })).success).toBe(true);
    expect(RuleEvidenceSchema.safeParse(validEvidence({ outcome: 'not_matched', blocking: false })).success).toBe(true);
  });

  it('distinguishes rule_error from not_matched', () => {
    expect(RuleEvidenceSchema.safeParse(validEvidence({ outcome: 'rule_error', blocking: false })).success).toBe(true);
  });

  it('unknown outcome must not assert a matchedFieldPath', () => {
    expect(RuleEvidenceSchema.safeParse(validEvidence({ outcome: 'unknown', matchedFieldPath: 'salaryMinK' })).success).toBe(false);
  });

  it('preserves multiple matches', () => {
    const matches = [
      { fieldPath: 'salaryMinK', excerpt: '15K', rawValue: '15', normalizedValue: 15 },
      { fieldPath: 'city', excerpt: '上海', rawValue: '上海', normalizedValue: '上海' },
    ];
    const r = parseRuleEvidenceJson(JSON.stringify(validEvidence({ matches })));
    expect(r.status).toBe('valid');
    if (r.status === 'valid') expect(r.evidence.matches).toHaveLength(2);
  });

  it('accepts restricted scalar-array and shallow-object values', () => {
    expect(RuleEvidenceSchema.safeParse(validEvidence({ rawValue: ['a', 'b'], normalizedValue: { min: 15, max: 25 } })).success).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { AnalysisContractError } from './contractErrors';
import {
  assertEvidenceKeysKnown,
  buildOrderedKeys,
  buildSetKeys,
  collectEvidenceKeys,
  EVIDENCE_KEY_PATTERN,
  evidenceFingerprint,
  parseEvidenceCatalog,
  type AnalysisEvidenceItem,
} from './evidenceCatalog';

function item(evidenceKey: string): AnalysisEvidenceItem {
  return {
    evidenceKey, kind: 'candidate_fact', label: '标签',
    statement: '陈述', polarity: 'neutral', strength: 'medium', sourcePath: 'p',
  };
}

describe('evidenceKey format', () => {
  it('accepts stable semantic keys and rejects db-id-like keys', () => {
    for (const k of ['candidate:salary', 'candidate:responsibility:1', 'rule:risk:2', 'resume:capability:1a2b3c4d']) {
      expect(EVIDENCE_KEY_PATTERN.test(k)).toBe(true);
    }
    for (const k of ['cand-1', 'ver_1', 'Candidate:Salary', 'candidate::1', '']) {
      expect(EVIDENCE_KEY_PATTERN.test(k)).toBe(false);
    }
  });
});

describe('buildSetKeys (order-independent)', () => {
  it('produces the same keys regardless of input order', () => {
    const a = buildSetKeys('candidate', 'stack', ['Go', 'Rust', 'Java']);
    const b = buildSetKeys('candidate', 'stack', ['Java', 'Go', 'Rust']);
    expect(a).toEqual(b);
  });

  it('collapses duplicates and whitespace before numbering', () => {
    expect(buildSetKeys('candidate', 'stack', ['Go', ' Go ', 'Go'])).toHaveLength(1);
  });
});

describe('buildOrderedKeys (business order preserved, content-fingerprinted)', () => {
  it('keeps identical content stable across reordering', () => {
    const keyA = buildOrderedKeys('candidate', 'responsibility', ['设计服务', '维护CI'])[0];
    const keyB = buildOrderedKeys('candidate', 'responsibility', ['维护CI', '设计服务'])[1];
    // "设计服务" 在两种顺序下拿到相同指纹主体（无重复消歧）。
    expect(keyA).toBe(keyB);
  });

  it('disambiguates identical repeated content with a stable suffix', () => {
    const keys = buildOrderedKeys('candidate', 'responsibility', ['重复', '重复']);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[1]).toMatch(/-2$/);
  });

  it('same content yields same fingerprint', () => {
    expect(evidenceFingerprint('  多   空格 ')).toBe(evidenceFingerprint('多 空格'));
  });
});

describe('parseEvidenceCatalog', () => {
  it('accepts a valid catalog and exposes its key set', () => {
    const catalog = parseEvidenceCatalog([item('candidate:salary'), item('rule:risk:1')]);
    expect(collectEvidenceKeys(catalog)).toEqual(new Set(['candidate:salary', 'rule:risk:1']));
  });

  it('rejects duplicate keys', () => {
    try {
      parseEvidenceCatalog([item('candidate:salary'), item('candidate:salary')]);
      throw new Error('expected error');
    } catch (error) {
      expect((error as AnalysisContractError).code).toBe('EVIDENCE_DUPLICATE_KEY');
    }
  });

  it('rejects invalid key format', () => {
    try {
      parseEvidenceCatalog([item('BAD KEY')]);
      throw new Error('expected error');
    } catch (error) {
      expect((error as AnalysisContractError).code).toBe('EVIDENCE_KEY_INVALID');
    }
  });

  it('rejects too many items', () => {
    const many = Array.from({ length: 101 }, (_, i) => item(`candidate:x:${i + 1}`));
    try {
      parseEvidenceCatalog(many);
      throw new Error('expected error');
    } catch (error) {
      expect((error as AnalysisContractError).code).toBe('EVIDENCE_TOO_MANY');
    }
  });
});

describe('assertEvidenceKeysKnown', () => {
  it('passes when all keys are in the allowed set', () => {
    expect(() => assertEvidenceKeysKnown(['candidate:salary'], new Set(['candidate:salary']))).not.toThrow();
  });

  it('fails loudly on any unknown key (never silently drops)', () => {
    try {
      assertEvidenceKeysKnown(['candidate:salary', 'ghost:key:1'], new Set(['candidate:salary']));
      throw new Error('expected error');
    } catch (error) {
      expect((error as AnalysisContractError).code).toBe('ANALYSIS_UNKNOWN_EVIDENCE_KEY');
    }
  });
});

import { describe, expect, it } from 'vitest';
import { AnalysisContractError } from './contractErrors';
import { parseJobMatchAnalysisPayload, PAYLOAD_MAX_BYTES } from './analysisPayload';
import { ALLOWED_KEYS, validPayload } from './contractFixtures';

function parse(payload: unknown, keys = ALLOWED_KEYS) {
  return parseJobMatchAnalysisPayload(JSON.stringify(payload), keys);
}

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected AnalysisContractError');
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisContractError);
    expect((error as AnalysisContractError).code).toBe(code);
  }
}

describe('JobMatchAnalysisPayloadV1 · happy paths', () => {
  it('accepts a full valid payload', () => {
    expect(parse(validPayload()).recommendation).toBe('apply_now');
  });

  it('accepts every recommendation value', () => {
    for (const recommendation of ['apply_now', 'stretch', 'verify', 'skip'] as const) {
      expect(parse(validPayload({ recommendation })).recommendation).toBe(recommendation);
    }
  });

  it('accepts every confidence value', () => {
    for (const confidence of ['low', 'medium', 'high'] as const) {
      expect(parse(validPayload({ confidence })).confidence).toBe(confidence);
    }
  });

  it('accepts fenced json output', () => {
    const fenced = '```json\n' + JSON.stringify(validPayload()) + '\n```';
    expect(parseJobMatchAnalysisPayload(fenced, ALLOWED_KEYS).confidence).toBe('high');
  });
});

describe('JobMatchAnalysisPayloadV1 · rejections', () => {
  it('rejects extra fields', () => {
    expectCode(() => parse({ ...validPayload(), matchScore: 87 }), 'ANALYSIS_SCHEMA_INVALID');
  });

  it('rejects HTML content', () => {
    const p = validPayload({ summary: '整体<strong>不错</strong>' });
    expectCode(() => parse(p), 'ANALYSIS_HTML_NOT_ALLOWED');
  });

  it('rejects internal database ids', () => {
    const p = validPayload({ summary: '见 analysis-task:v1:deadbeef 结果' });
    expectCode(() => parse(p), 'ANALYSIS_INTERNAL_ID_LEAK');
  });

  it('rejects unknown evidenceKey references', () => {
    const p = validPayload();
    p.jobFacts[0]!.evidenceKeys = ['ghost:key:1'];
    expectCode(() => parse(p), 'ANALYSIS_UNKNOWN_EVIDENCE_KEY');
  });

  it('rejects a non-unknown point that cites no evidence', () => {
    const p = validPayload();
    p.gaps[0]!.evidenceKeys = [];
    expectCode(() => parse(p), 'ANALYSIS_SCHEMA_INVALID');
  });

  it('rejects missing disguised as a negative fact (unknown + negative impact)', () => {
    const p = validPayload();
    p.uncertainties[0]!.impact = 'negative';
    expectCode(() => parse(p), 'ANALYSIS_SCHEMA_INVALID');
  });

  it('rejects hardConstraints with a disallowed kind', () => {
    const p = validPayload();
    p.hardConstraints[0]!.kind = 'inference';
    expectCode(() => parse(p), 'ANALYSIS_SCHEMA_INVALID');
  });

  it('rejects payload over the 32KB limit (size checked before schema)', () => {
    // 大小检查在 Zod 之前：超 32KB 的 JSON 一律先判 TOO_LARGE，确定性触发。
    const text = JSON.stringify({ ...validPayload(), filler: 'x'.repeat(40_000) });
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(PAYLOAD_MAX_BYTES);
    expectCode(() => parseJobMatchAnalysisPayload(text, ALLOWED_KEYS), 'ANALYSIS_PAYLOAD_TOO_LARGE');
  });

  it('rejects markdown prose mixed with json', () => {
    const mixed = '这是分析结果：\n```json\n' + JSON.stringify(validPayload()) + '\n```\n谢谢';
    expectCode(() => parseJobMatchAnalysisPayload(mixed, ALLOWED_KEYS), 'ANALYSIS_JSON_INVALID');
  });

  it('rejects invalid json', () => {
    expectCode(() => parseJobMatchAnalysisPayload('{ not json', ALLOWED_KEYS), 'ANALYSIS_JSON_INVALID');
  });

  it('never echoes rawText in the error message', () => {
    const secret = 'SUPER_SECRET_MARKER_9137';
    try {
      parseJobMatchAnalysisPayload(`{"contractVersion": 1, "junk": "${secret}"`, ALLOWED_KEYS);
      throw new Error('expected error');
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

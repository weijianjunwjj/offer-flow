import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_TASK_ID_PATTERN,
  buildJobMatchAnalysisInputHash,
  buildJobMatchAnalysisTaskId,
  isAnalysisTaskId,
} from './inputHash';
import { validSnapshot } from './contractFixtures';

describe('buildJobMatchAnalysisInputHash', () => {
  it('is a 64-char lowercase sha256', () => {
    expect(buildJobMatchAnalysisInputHash(validSnapshot())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores createdAt', () => {
    const a = buildJobMatchAnalysisInputHash(validSnapshot({ createdAt: 1 }));
    const b = buildJobMatchAnalysisInputHash(validSnapshot({ createdAt: 999_999 }));
    expect(a).toBe(b);
  });

  it('is stable under semantic field key ordering (canonical)', () => {
    const base = validSnapshot();
    // 重新构造一个语义相同但字段书写顺序不同的快照。
    const reordered = validSnapshot();
    reordered.provider = { modelVersion: null, modelName: 'deepseek-chat', providerName: 'deepseek' } as typeof reordered.provider;
    expect(buildJobMatchAnalysisInputHash(base)).toBe(buildJobMatchAnalysisInputHash(reordered));
  });

  it('changes when candidate contentHash changes', () => {
    const a = buildJobMatchAnalysisInputHash(validSnapshot());
    const snap = validSnapshot();
    snap.candidate.contentHash = 'chash-CHANGED';
    expect(buildJobMatchAnalysisInputHash(snap)).not.toBe(a);
  });

  it('changes when prompt / policy / provider / model versions change', () => {
    const base = buildJobMatchAnalysisInputHash(validSnapshot());
    expect(buildJobMatchAnalysisInputHash(validSnapshot({ promptVersion: 'prompt-v2' }))).not.toBe(base);
    expect(buildJobMatchAnalysisInputHash(validSnapshot({ analysisPolicyVersion: 'policy-v2' }))).not.toBe(base);
    expect(buildJobMatchAnalysisInputHash(validSnapshot({ providerPolicyVersion: 'pp-v2' }))).not.toBe(base);
    const providerChanged = validSnapshot();
    providerChanged.provider.modelName = 'deepseek-reasoner';
    expect(buildJobMatchAnalysisInputHash(providerChanged)).not.toBe(base);
  });

  it('changes when rule projection hash changes', () => {
    const base = buildJobMatchAnalysisInputHash(validSnapshot());
    const snap = validSnapshot();
    snap.ruleProjection.projectionHash = 'proj-CHANGED';
    expect(buildJobMatchAnalysisInputHash(snap)).not.toBe(base);
  });
});

describe('buildJobMatchAnalysisTaskId', () => {
  it('produces a well-formed deterministic task id', () => {
    const hash = buildJobMatchAnalysisInputHash(validSnapshot());
    const id = buildJobMatchAnalysisTaskId(hash);
    expect(id).toBe(`analysis-task:v1:${hash}`);
    expect(ANALYSIS_TASK_ID_PATTERN.test(id)).toBe(true);
    expect(isAnalysisTaskId(id)).toBe(true);
  });

  it('rejects a malformed input hash', () => {
    expect(() => buildJobMatchAnalysisTaskId('not-a-sha')).toThrow(TypeError);
    expect(() => buildJobMatchAnalysisTaskId('ABCDEF')).toThrow(TypeError);
  });

  it('task id does not embed snapshot plaintext', () => {
    const id = buildJobMatchAnalysisTaskId(buildJobMatchAnalysisInputHash(validSnapshot()));
    expect(id).not.toContain('Acme');
    expect(id).not.toContain('苏州');
  });
});

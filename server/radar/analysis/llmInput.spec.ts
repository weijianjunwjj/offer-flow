import { describe, expect, it } from 'vitest';
import { validSnapshot } from './contractFixtures';
import { buildJobMatchAnalysisLlmInput } from './llmInput';
import { scanInternalIdLeak, scanForbiddenContent } from './safetyScan';
import { parseJobMatchAnalysisInputSnapshot } from './contracts';

/** 用契约 fixture 构造一份 strict 合法快照后派生 LLM 输入。 */
function llmFrom(mutate: (snap: ReturnType<typeof validSnapshot>) => void = () => {}) {
  const snap = validSnapshot();
  mutate(snap);
  return buildJobMatchAnalysisLlmInput(parseJobMatchAnalysisInputSnapshot(snap));
}

describe('buildJobMatchAnalysisLlmInput', () => {
  it('produces a contract-valid, de-identified LLM input aligned with its catalog', () => {
    const { llmInput, evidenceCatalog, allowedEvidenceKeys } = llmFrom();
    expect(llmInput.contractVersion).toBe(1);
    expect(llmInput.jobFacts.salaryText).toBe('20-35K/month');
    expect(allowedEvidenceKeys.size).toBe(evidenceCatalog.length);
    // 目录键与 llmInput.evidenceCatalog 一致。
    expect(new Set(llmInput.evidenceCatalog.map((e) => e.evidenceKey))).toEqual(allowedEvidenceKeys);
  });

  it('contains no internal database ids anywhere in the model-visible payload', () => {
    const { llmInput } = llmFrom();
    expect(scanInternalIdLeak(llmInput)).toEqual([]);
    // 快照里的内部 ID（candidateId/versionId 等）必须不出现在 LLM 输入的任何字符串值中。
    const serialized = JSON.stringify(llmInput);
    for (const id of ['cand-1', 'ver-1', 'resume-1', 'profile-1', 'chash-1', 'snap-1']) {
      expect(serialized).not.toContain(id);
    }
  });

  it('never forwards forbidden content (rejects at parse if snapshot were tainted upstream)', () => {
    const { llmInput } = llmFrom();
    expect(scanForbiddenContent(llmInput)).toEqual([]);
  });

  it('derives stable evidence keys that do not drift when set-typed fields are reordered', () => {
    const forward = llmFrom((s) => { s.candidate.normalizedFacts.technicalStack = ['Go', 'Kubernetes', 'Redis']; });
    const reversed = llmFrom((s) => { s.candidate.normalizedFacts.technicalStack = ['Redis', 'Kubernetes', 'Go']; });
    const keys = (r: typeof forward) => r.evidenceCatalog.filter((e) => e.evidenceKey.startsWith('candidate:tech-stack')).map((e) => e.evidenceKey).sort();
    expect(keys(reversed)).toEqual(keys(forward));
  });

  it('maps optional capability evidence into the catalog when present', () => {
    const withCap = llmFrom((s) => {
      s.capabilityBaseline = {
        versionId: 'cap-1', contentHash: 'caphash-1',
        safeSnapshot: { strengths: ['分布式设计'], gaps: ['前端深度不足'] },
      };
    });
    const kinds = new Set(withCap.evidenceCatalog.map((e) => e.kind));
    expect(kinds).toContain('capability_evidence');
  });

  it('projects salary text as null when no salary is present', () => {
    const { llmInput } = llmFrom((s) => {
      s.candidate.normalizedFacts.salaryMinK = null;
      s.candidate.normalizedFacts.salaryMaxK = null;
    });
    expect(llmInput.jobFacts.salaryText).toBeNull();
  });
});

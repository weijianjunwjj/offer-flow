import { describe, expect, it, vi } from 'vitest';
import {
  makeCandidateEvidenceContentFixture,
  makeCapabilityBaselineDraftFixture,
} from '../../src/domain/capability-baseline/testFixtures';

const mocks = vi.hoisted(() => ({
  chatCompletion: vi.fn(),
  getLlmConfig: vi.fn(() => ({ baseUrl: 'https://fake', apiKey: 'k', model: 'fake-model' })),
  isLlmConfigured: vi.fn(() => true),
}));

vi.mock('../llm/provider', () => ({
  chatCompletion: mocks.chatCompletion,
  getLlmConfig: mocks.getLlmConfig,
  isLlmConfigured: mocks.isLlmConfigured,
}));

async function importFresh() {
  return import('./aiProvider');
}

const legacyBaseline = JSON.stringify({ overallAssessment: '旧结构', riskLevel: '高' });
const legacyEvidence = JSON.stringify([{ conclusion: '旧结构', score: 3 }]);
const snapshot = { profile: {} } as never;

describe('能力基线 AI Provider · 错误分类', () => {
  it('超时 → AI_PROVIDER_TIMEOUT，不进入结构修复（只调用一次）', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({ rawText: '', model: 'fake-model', error: 'LLM 调用超时，请稍后重试' });
    const { deepSeekCapabilityBaselineProvider } = await importFresh();
    await expect(deepSeekCapabilityBaselineProvider.generateBaseline(snapshot))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_TIMEOUT' });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it('HTTP 失败 → AI_PROVIDER_UNAVAILABLE，不进入结构修复', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({ rawText: '', model: 'fake-model', error: 'LLM 调用失败 (HTTP 500)' });
    const { deepSeekCapabilityBaselineProvider } = await importFresh();
    await expect(deepSeekCapabilityBaselineProvider.generateEvidence(snapshot))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_UNAVAILABLE' });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('能力基线 AI Provider · 候选证据结构修复', () => {
  it('首次即合法：只调用一次', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({
      rawText: JSON.stringify([makeCandidateEvidenceContentFixture()]), model: 'fake-model',
    });
    const { deepSeekCapabilityBaselineProvider, parseCapabilityEvidenceAiOutput } = await importFresh();
    const result = await deepSeekCapabilityBaselineProvider.generateEvidence(snapshot);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    expect(() => parseCapabilityEvidenceAiOutput(result.rawText)).not.toThrow();
  });

  it('首次旧结构，第二次修复成功：恰好两次，第二次 Prompt 含 fieldErrors', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: legacyEvidence, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: JSON.stringify([makeCandidateEvidenceContentFixture()]), model: 'fake-model' });
    const { deepSeekCapabilityBaselineProvider } = await importFresh();
    await deepSeekCapabilityBaselineProvider.generateEvidence(snapshot);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
    expect(mocks.chatCompletion.mock.calls[1]?.[1] as string).toContain('fieldErrors');
  });

  it('连续两次结构错误：恰好两次，抛 AI_STRUCTURED_OUTPUT_INVALID 且 attempts=2', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: legacyEvidence, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: legacyEvidence, model: 'fake-model' });
    const { deepSeekCapabilityBaselineProvider } = await importFresh();
    await expect(deepSeekCapabilityBaselineProvider.generateEvidence(snapshot)).rejects.toMatchObject({
      code: 'AI_STRUCTURED_OUTPUT_INVALID', details: { attempts: 2 },
    });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe('能力基线 AI Provider · 基线结构修复', () => {
  it('首次即合法：只调用一次', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion.mockResolvedValue({
      rawText: JSON.stringify(makeCapabilityBaselineDraftFixture()), model: 'fake-model',
    });
    const { deepSeekCapabilityBaselineProvider, parseCapabilityBaselineAiOutput } = await importFresh();
    const result = await deepSeekCapabilityBaselineProvider.generateBaseline(snapshot);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
    expect(() => parseCapabilityBaselineAiOutput(result.rawText)).not.toThrow();
  });

  it('首次旧结构，第二次修复成功：恰好两次', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: legacyBaseline, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: JSON.stringify(makeCapabilityBaselineDraftFixture()), model: 'fake-model' });
    const { deepSeekCapabilityBaselineProvider } = await importFresh();
    await deepSeekCapabilityBaselineProvider.generateBaseline(snapshot);
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });

  it('连续两次结构错误：恰好两次，不再第三次', async () => {
    mocks.chatCompletion.mockReset();
    mocks.chatCompletion
      .mockResolvedValueOnce({ rawText: legacyBaseline, model: 'fake-model' })
      .mockResolvedValueOnce({ rawText: legacyBaseline, model: 'fake-model' });
    const { deepSeekCapabilityBaselineProvider } = await importFresh();
    await expect(deepSeekCapabilityBaselineProvider.generateBaseline(snapshot)).rejects.toMatchObject({
      code: 'AI_STRUCTURED_OUTPUT_INVALID',
    });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(2);
  });
});

describe('能力基线 AI Provider · Prompt 契约', () => {
  it('证据 Prompt 含枚举与护栏；基线 Prompt 含关键字段与护栏', async () => {
    const { CAPABILITY_EVIDENCE_SYSTEM_PROMPT, CAPABILITY_BASELINE_SYSTEM_PROMPT } = await importFresh();
    for (const token of ['support', 'counter', 'neutral', 'strong', 'medium', 'weak', '学历', '短期无回复']) {
      expect(CAPABILITY_EVIDENCE_SYSTEM_PROMPT).toContain(token);
    }
    for (const token of [
      'capabilities', 'externalConstraints', 'conclusionStatus', 'established', 'contradicted',
      'education', '短期无回复', '不得写成能力反证',
    ]) {
      expect(CAPABILITY_BASELINE_SYSTEM_PROMPT).toContain(token);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../job-memory/requestHash';
import { AnalysisContractError } from './contractErrors';
import { parseJobMatchAnalysisLlmInput } from './llmContracts';
import { validLlmInput } from './contractFixtures';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error('expected AnalysisContractError');
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisContractError);
    expect((error as AnalysisContractError).code).toBe(code);
  }
}

describe('JobMatchAnalysisLlmInputV1', () => {
  it('accepts a valid input free of internal ids', () => {
    expect(parseJobMatchAnalysisLlmInput(validLlmInput()).contractVersion).toBe(1);
  });

  it('serializes cleanly', () => {
    expect(() => canonicalJson(parseJobMatchAnalysisLlmInput(validLlmInput()))).not.toThrow();
  });

  it('rejects an internal candidateId key anywhere (recursive)', () => {
    const input = validLlmInput();
    (input.person as Record<string, unknown>).candidateId = 'cand-1';
    expectCode(() => parseJobMatchAnalysisLlmInput(input), 'LLM_INPUT_INVALID');
  });

  it('rejects an internal id key that passes schema via a nested strict-allowed shape', () => {
    // 构造一个 schema 合法但含内部 ID 键的对象：把 versionId 混进 evidenceCatalog item 是不行的
    // （strictObject），故改为在 description 值里放确定性任务 ID 前缀，命中值扫描。
    const input = validLlmInput();
    input.jobFacts.description = '参考 analysis-task:v1:abcd 的历史结果';
    expectCode(() => parseJobMatchAnalysisLlmInput(input), 'LLM_INPUT_INTERNAL_ID_LEAK');
  });

  it('rejects sensitive credential content', () => {
    const input = validLlmInput();
    input.jobFacts.description = 'Authorization: Bearer secret.token';
    expectCode(() => parseJobMatchAnalysisLlmInput(input), 'LLM_INPUT_SENSITIVE_CONTENT');
  });

  it('rejects unknown keys (strictObject)', () => {
    const input = { ...validLlmInput(), extra: 1 };
    expectCode(() => parseJobMatchAnalysisLlmInput(input), 'LLM_INPUT_INVALID');
  });
});

/**
 * V8-4 "生成 + 一次结构修复"编排测试。
 * 不写任何数据库、不调用真实模型；用内存 fake Provider 覆盖成功/修复/失败/传输错误/取消。
 */
import { describe, expect, it } from 'vitest';
import { validSnapshot } from './contractFixtures';
import { parseJobMatchAnalysisInputSnapshot } from './contracts';
import { buildJobMatchAnalysisLlmInput } from './llmInput';
import { generateAndParseJobMatchAnalysis, isRepairableContractError, buildValidationSummary } from './repair';
import { AnalysisProviderError } from './provider';
import {
  deterministicSuccessProvider,
  malformedThenRepairSuccessProvider,
  schemaInvalidThenRepairProvider,
  unknownEvidenceKeyThenRepairProvider,
  malformedThenRepairFailureProvider,
  timeoutProvider,
  networkErrorProvider,
  rateLimitProvider,
  sensitiveLeakProvider,
  delayedCancellableProvider,
} from './analysisProviderFakes';

function fixtureInput() {
  const { llmInput, allowedEvidenceKeys } = buildJobMatchAnalysisLlmInput(
    parseJobMatchAnalysisInputSnapshot(validSnapshot()),
  );
  return { llmInput, allowedEvidenceKeys };
}

async function run(provider: ReturnType<typeof deterministicSuccessProvider>, signal?: AbortSignal) {
  const { llmInput, allowedEvidenceKeys } = fixtureInput();
  return generateAndParseJobMatchAnalysis({ provider, llmInput, allowedEvidenceKeys, signal });
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
    throw new Error('expected AnalysisProviderError');
  } catch (error) {
    expect(error).toBeInstanceOf(AnalysisProviderError);
    expect((error as AnalysisProviderError).code).toBe(code);
  }
}

describe('generateAndParseJobMatchAnalysis', () => {
  it('returns payload on first valid JSON (no repair)', async () => {
    const provider = deterministicSuccessProvider();
    const result = await run(provider);
    expect(result.repaired).toBe(false);
    expect(result.payload.contractVersion).toBe(1);
    expect(provider.counts).toEqual({ generate: 1, repair: 0 });
  });

  it('repairs once on malformed JSON then succeeds (2 model calls max)', async () => {
    const provider = malformedThenRepairSuccessProvider();
    const result = await run(provider);
    expect(result.repaired).toBe(true);
    expect(provider.counts).toEqual({ generate: 1, repair: 1 });
  });

  it('repairs once on schema-invalid output then succeeds', async () => {
    const provider = schemaInvalidThenRepairProvider();
    const result = await run(provider);
    expect(result.repaired).toBe(true);
    expect(provider.counts).toEqual({ generate: 1, repair: 1 });
  });

  it('repairs once on unknown evidenceKey then succeeds', async () => {
    const provider = unknownEvidenceKeyThenRepairProvider();
    const result = await run(provider);
    expect(result.repaired).toBe(true);
    expect(provider.counts).toEqual({ generate: 1, repair: 1 });
  });

  it('throws STRUCTURE_REPAIR_FAILED when repair also fails (never a 3rd call)', async () => {
    const provider = malformedThenRepairFailureProvider();
    await expectCode(() => run(provider), 'STRUCTURE_REPAIR_FAILED');
    expect(provider.counts).toEqual({ generate: 1, repair: 1 });
  });

  it('does not repair on provider timeout', async () => {
    const provider = timeoutProvider();
    await expectCode(() => run(provider), 'PROVIDER_TIMEOUT');
    expect(provider.counts).toEqual({ generate: 1, repair: 0 });
  });

  it('does not repair on network error', async () => {
    const provider = networkErrorProvider();
    await expectCode(() => run(provider), 'PROVIDER_NETWORK_ERROR');
    expect(provider.counts.repair).toBe(0);
  });

  it('does not repair on rate limit', async () => {
    const provider = rateLimitProvider();
    await expectCode(() => run(provider), 'PROVIDER_RATE_LIMIT');
    expect(provider.counts.repair).toBe(0);
  });

  it('does not repair on sensitive-content leak; maps to SENSITIVE_CONTENT_LEAK', async () => {
    const provider = sensitiveLeakProvider();
    await expectCode(() => run(provider), 'SENSITIVE_CONTENT_LEAK');
    expect(provider.counts.repair).toBe(0);
  });

  it('cancels via AbortSignal → CANCELLED_BY_USER', async () => {
    const provider = delayedCancellableProvider();
    const controller = new AbortController();
    const promise = run(provider, controller.signal);
    controller.abort();
    await expectCode(() => promise, 'CANCELLED_BY_USER');
  });

  it('never leaks rawText / prompt / secrets in error messages', async () => {
    const provider = malformedThenRepairFailureProvider();
    try {
      await run(provider);
      throw new Error('expected throw');
    } catch (error) {
      const message = (error as AnalysisProviderError).message;
      expect(message).not.toContain('坏的一次');
      expect(message).not.toContain('坏的两次');
      expect(message).not.toContain('evidenceCatalog');
    }
  });
});

describe('buildValidationSummary', () => {
  it('includes the target contract version and each desensitized issue (path + code)', () => {
    const summary = buildValidationSummary('ANALYSIS_SCHEMA_INVALID', 'dimensions.roleFit.kind', [
      { path: 'dimensions.roleFit.assessment', code: 'invalid_enum_value', message: '期望 strong|moderate|weak|unknown' },
      { path: '', code: 'unrecognized_keys', message: '存在未知字段' },
    ]);
    expect(summary).toContain('ANALYSIS_SCHEMA_INVALID');
    expect(summary).toContain('contractVersion=1');
    expect(summary).toContain('dimensions.roleFit.assessment');
    expect(summary).toContain('invalid_enum_value');
    expect(summary).toContain('(根对象)'); // 顶层空 path 的可读化
  });

  it('falls back to detail when no structured issues are present, and stays bounded', () => {
    const summary = buildValidationSummary('ANALYSIS_JSON_INVALID', 'x'.repeat(2000), undefined);
    expect(summary).toContain('ANALYSIS_JSON_INVALID');
    expect(summary.length).toBeLessThanOrEqual(800);
  });

  it('passes a summary carrying issues into the repair call', async () => {
    let capturedSummary = '';
    const provider = schemaInvalidThenRepairProvider();
    const originalRepair = provider.repair.bind(provider);
    provider.repair = (input, prev, summary, signal) => {
      capturedSummary = summary;
      return originalRepair(input, prev, summary, signal);
    };
    await run(provider);
    expect(capturedSummary).toContain('contractVersion=1');
    expect(capturedSummary).toContain('具体问题');
  });
});

describe('isRepairableContractError', () => {
  it('treats JSON/schema/unknown-key/html/too-large as repairable', () => {
    for (const code of ['ANALYSIS_JSON_INVALID', 'ANALYSIS_SCHEMA_INVALID', 'ANALYSIS_UNKNOWN_EVIDENCE_KEY', 'ANALYSIS_HTML_NOT_ALLOWED', 'ANALYSIS_PAYLOAD_TOO_LARGE'] as const) {
      expect(isRepairableContractError(code)).toBe(true);
    }
  });

  it('treats leak codes as non-repairable', () => {
    expect(isRepairableContractError('ANALYSIS_SENSITIVE_CONTENT')).toBe(false);
    expect(isRepairableContractError('ANALYSIS_INTERNAL_ID_LEAK')).toBe(false);
  });
});

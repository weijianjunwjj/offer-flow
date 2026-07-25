/**
 * V8-4 analysis:e2e 专用「闸门式」延迟成功 Provider（仅供 E2E 编排，进程内、确定性）。
 *
 * 绝不读取环境变量 / 真实 API key，绝不访问外网：generate 阻塞在一个由测试显式释放的 Promise 上，
 * 使任务可观测地停在 running，供「运行中 → 刷新 → 恢复 running → 释放 → succeeded」场景使用。
 * 不用固定长 sleep：running 窗口由测试经控制端点释放，完全确定。
 */
import {
  type AnalysisProviderCallResult,
  type JobMatchAnalysisProvider,
} from '../server/radar/analysis/provider';
import type { JobMatchAnalysisLlmInputV1 } from '../server/radar/analysis/llmContracts';

/**
 * 合法 JobMatchAnalysisPayloadV1：仅引用输入目录中真实存在的 evidenceKey（交叉验证必过），
 * 且带一条含证据引用的 jobFact，使前端「证据引用」展开区可被 E2E 断言。目录为空则退化为不引用。
 */
function validPayloadJson(input: JobMatchAnalysisLlmInputV1): string {
  const firstKey = input.evidenceCatalog[0]?.evidenceKey ?? null;
  const evidenceKeys = firstKey === null ? [] : [firstKey];
  const dim = { summary: '暂无足够证据形成结论', assessment: 'unknown', points: [] };
  return JSON.stringify({
    contractVersion: 1,
    jobFacts: [{ statement: '岗位关键事实（E2E 确定性样例）', kind: 'fact', evidenceKeys }],
    dimensions: { roleFit: dim, capabilityFit: dim, businessAndCompanyFit: dim, cityAndSalaryFit: dim },
    transferableEvidence: [], gaps: [], risks: [], counterEvidence: [], uncertainties: [],
    missingEvidence: [], hardConstraints: [],
    recommendation: 'verify', confidence: 'low', summary: '证据不足，建议进一步核实',
    recruiterQuestions: [], communicationAngles: [],
  });
}

export interface GatedProvider {
  provider: JobMatchAnalysisProvider;
  /** 释放当前闸门：让阻塞中的 generate 立即返回合法 payload。可重复调用（下次 generate 重新上闸）。 */
  release: () => void;
}

/**
 * 每次 generate 新建一道闸门并暴露其 resolver；调用 release() 放行当前闸门后自动重置，
 * 支持多次分析（如刷新后新任务）各自独立阻塞。
 */
export function createGatedSuccessProvider(): GatedProvider {
  const META = { provider: 'fake', model: 'fake-model' };
  let pendingRelease: (() => void) | null = null;

  function armGate(): Promise<void> {
    return new Promise<void>((resolve) => { pendingRelease = resolve; });
  }

  const provider: JobMatchAnalysisProvider = {
    isConfigured: () => true,
    providerName: () => META.provider,
    modelName: () => META.model,
    async generate(input: JobMatchAnalysisLlmInputV1): Promise<AnalysisProviderCallResult> {
      await armGate();
      return { rawText: validPayloadJson(input), ...META };
    },
    async repair(input: JobMatchAnalysisLlmInputV1): Promise<AnalysisProviderCallResult> {
      return { rawText: validPayloadJson(input), ...META };
    },
  };

  return {
    provider,
    release: () => {
      const resolve = pendingRelease;
      pendingRelease = null;
      resolve?.();
    },
  };
}

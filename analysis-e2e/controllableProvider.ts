/**
 * V8-4 analysis:e2e 专用「可控」Provider（仅供 E2E 编排，进程内、确定性）。
 *
 * 绝不读取环境变量 / 真实 API key，绝不访问外网。支持四种测试模式，由 harness 控制端点切换：
 * - delayed_success       ：generate 阻塞在闸门上，释放后返回合法 payload（running 窗口可观测）。
 * - malformed_then_repair_success：首次 generate 立即返回结构非法文本（触发一次 repair），repair 返回合法。
 * - fail_once_then_success：首次 generate 抛 PROVIDER_NETWORK_ERROR（不进入 repair），其后返回合法。
 * - delayed_cancellable   ：同 delayed_success（闸门阻塞），供「running → 取消 → 迟到丢弃」使用。
 *
 * 只记录安全调用计数（generateCalls/repairCalls/generateSettled），绝不记录或输出
 * 完整 Prompt / JD / 简历 / Provider 原始响应。测试模式绝不出现在真实入口。
 */
import {
  AnalysisProviderError,
  type AnalysisProviderCallResult,
  type JobMatchAnalysisProvider,
} from '../server/radar/analysis/provider';
import type { JobMatchAnalysisLlmInputV1 } from '../server/radar/analysis/llmContracts';

export type ProviderMode =
  | 'delayed_success'
  | 'malformed_then_repair_success'
  | 'fail_once_then_success'
  | 'delayed_cancellable';

/** 结构非法文本中携带的可识别标记：测试断言页面 body 绝不包含它（不泄漏 malformed 原文）。 */
export const MALFORMED_MARKER = 'E2E_MALFORMED_e3f1_not_json';

export interface ProviderCounts {
  mode: ProviderMode;
  generateCalls: number;
  repairCalls: number;
  /** generate 已 settle（resolve/reject）的次数：取消场景用它做「迟到结果已被后台处理」的同步栅栏。 */
  generateSettled: number;
}

export interface ControllableProvider {
  provider: JobMatchAnalysisProvider;
  /** 释放当前闸门：让阻塞中的 generate 立即返回合法 payload。可重复调用（下次 generate 重新上闸）。 */
  release: () => void;
  /** 切换测试模式并复位计数与闸门（beforeEach 用）。 */
  setMode: (mode: ProviderMode) => void;
  /** 只读安全计数快照。 */
  counts: () => ProviderCounts;
}

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

/**
 * 单实例可控 Provider。模式与计数为进程内共享状态；单 worker 串行下无并发写。
 * generate 的闸门只用于 delayed_* 模式；malformed/fail 模式立即返回或抛出（不上闸）。
 */
export function createControllableProvider(): ControllableProvider {
  const META = { provider: 'fake', model: 'fake-model' };
  let mode: ProviderMode = 'delayed_success';
  let generateCalls = 0;
  let repairCalls = 0;
  let generateSettled = 0;
  let pendingRelease: (() => void) | null = null;

  function armGate(): Promise<void> {
    return new Promise<void>((resolve) => { pendingRelease = resolve; });
  }
  function releaseGate(): void {
    const resolve = pendingRelease;
    pendingRelease = null;
    resolve?.();
  }

  const provider: JobMatchAnalysisProvider = {
    isConfigured: () => true,
    providerName: () => META.provider,
    modelName: () => META.model,
    async generate(input: JobMatchAnalysisLlmInputV1): Promise<AnalysisProviderCallResult> {
      const callIndex = (generateCalls += 1); // 本 provider 生命周期内的第几次 generate。
      try {
        if (mode === 'delayed_success' || mode === 'delayed_cancellable') {
          await armGate();
          return { rawText: validPayloadJson(input), ...META };
        }
        if (mode === 'malformed_then_repair_success') {
          // 首次返回结构非法文本 → parse 抛 ANALYSIS_JSON_INVALID（可修复）→ 触发一次 repair。
          return { rawText: `${MALFORMED_MARKER} <<<`, ...META };
        }
        // fail_once_then_success：首次抛传输类错误（不进入 repair），其后成功。
        if (callIndex === 1) {
          throw new AnalysisProviderError('PROVIDER_NETWORK_ERROR', '模型服务网络异常，可人工重试');
        }
        return { rawText: validPayloadJson(input), ...META };
      } finally {
        generateSettled += 1;
      }
    },
    async repair(input: JobMatchAnalysisLlmInputV1): Promise<AnalysisProviderCallResult> {
      repairCalls += 1;
      return { rawText: validPayloadJson(input), ...META };
    },
  };

  return {
    provider,
    release: releaseGate,
    setMode: (next: ProviderMode) => {
      mode = next;
      generateCalls = 0;
      repairCalls = 0;
      generateSettled = 0;
      pendingRelease = null; // 丢弃上一场景遗留闸门（reset 前已确保无 inflight）。
    },
    counts: () => ({ mode, generateCalls, repairCalls, generateSettled }),
  };
}

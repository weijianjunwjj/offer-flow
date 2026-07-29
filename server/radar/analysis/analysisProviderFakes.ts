/**
 * V8-4 测试专用分析 Provider（仅供单测/编排测试）。
 *
 * 绝不读取环境变量、绝不访问外网：全部为确定性内存实现。
 * 覆盖：确定性成功 / 先坏后修成功 / 先坏后修再失败 / 超时 / 网络错误 / 限流 / 可取消延迟。
 * 每个 fake 记录 generate/repair 调用次数，供"最多两次模型调用"断言。
 */
import {
  AnalysisProviderError,
  type AnalysisProviderCallResult,
  type JobMatchAnalysisProvider,
} from './provider';

/** 最小合法 JobMatchAnalysisPayloadV1（不引用任何 evidenceKey → 交叉验证必过）。 */
export function minimalValidPayloadJson(): string {
  const dim = { summary: '暂无足够证据形成结论', assessment: 'unknown', points: [] };
  return JSON.stringify({
    contractVersion: 1,
    jobFacts: [],
    dimensions: { roleFit: dim, capabilityFit: dim, businessAndCompanyFit: dim, cityAndSalaryFit: dim },
    transferableEvidence: [], gaps: [], risks: [], counterEvidence: [], uncertainties: [],
    missingEvidence: [], hardConstraints: [],
    recommendation: 'verify', confidence: 'low', summary: '证据不足，建议进一步核实',
    recruiterQuestions: [], communicationAngles: [],
  });
}

/** 调用计数（generate + repair）。 */
export interface CallCounts {
  generate: number;
  repair: number;
}

/** 可观测 fake：暴露 counts 以断言调用次数。 */
export interface CountingProvider extends JobMatchAnalysisProvider {
  counts: CallCounts;
}

const META = { provider: 'fake', model: 'fake-model' };
const ok = (rawText: string): AnalysisProviderCallResult => ({ rawText, ...META });

/** 基座：默认已配置；generate/repair 由子类覆盖；统一计数。 */
function base(
  gen: (self: CountingProvider, signal?: AbortSignal) => Promise<AnalysisProviderCallResult>,
  rep: (self: CountingProvider, signal?: AbortSignal) => Promise<AnalysisProviderCallResult>,
): CountingProvider {
  const self: CountingProvider = {
    counts: { generate: 0, repair: 0 },
    isConfigured: () => true,
    providerName: () => META.provider,
    modelName: () => META.model,
    async generate(_input, signal) {
      self.counts.generate += 1;
      return gen(self, signal);
    },
    async repair(_input, _prev, _summary, signal) {
      self.counts.repair += 1;
      return rep(self, signal);
    },
  };
  return self;
}

/** 首次即返回合法 JSON。 */
export function deterministicSuccessProvider(): CountingProvider {
  return base(async () => ok(minimalValidPayloadJson()), async () => ok(minimalValidPayloadJson()));
}

/** 首次返回非法 JSON，repair 返回合法 JSON。 */
export function malformedThenRepairSuccessProvider(): CountingProvider {
  return base(async () => ok('这不是 JSON'), async () => ok(minimalValidPayloadJson()));
}

/** 首次 schema 非法（缺字段），repair 合法。 */
export function schemaInvalidThenRepairProvider(): CountingProvider {
  return base(async () => ok('{"contractVersion":1}'), async () => ok(minimalValidPayloadJson()));
}

/** 首次引用目录外 evidenceKey，repair 合法（不引用任何键）。 */
export function unknownEvidenceKeyThenRepairProvider(): CountingProvider {
  const bad = JSON.parse(minimalValidPayloadJson());
  bad.jobFacts = [{ statement: '越迁软件后端岗', kind: 'fact', evidenceKeys: ['candidate:ghost:1'] }];
  return base(async () => ok(JSON.stringify(bad)), async () => ok(minimalValidPayloadJson()));
}

/** 两次都非法 JSON：触发 STRUCTURE_REPAIR_FAILED。 */
export function malformedThenRepairFailureProvider(): CountingProvider {
  return base(async () => ok('坏的一次'), async () => ok('坏的两次'));
}

/** 生成即超时（不进入 repair）。 */
export function timeoutProvider(): CountingProvider {
  return base(
    async () => { throw new AnalysisProviderError('PROVIDER_TIMEOUT', 'Provider 调用超时'); },
    async () => ok(minimalValidPayloadJson()),
  );
}

/** 生成即网络错误。 */
export function networkErrorProvider(): CountingProvider {
  return base(
    async () => { throw new AnalysisProviderError('PROVIDER_NETWORK_ERROR', 'Provider 网络调用失败'); },
    async () => ok(minimalValidPayloadJson()),
  );
}

/** 生成即限流。 */
export function rateLimitProvider(): CountingProvider {
  return base(
    async () => { throw new AnalysisProviderError('PROVIDER_RATE_LIMIT', 'Provider 触发限流（HTTP 429）'); },
    async () => ok(minimalValidPayloadJson()),
  );
}

/** 首次输出泄漏敏感内容（rawText 含 Authorization），不得进入 repair。 */
export function sensitiveLeakProvider(): CountingProvider {
  const bad = JSON.parse(minimalValidPayloadJson());
  bad.summary = 'Authorization: Bearer sk-secret-token-abc.def';
  return base(async () => ok(JSON.stringify(bad)), async () => ok(minimalValidPayloadJson()));
}

/** 可取消延迟 fake：await 一个由 signal 中断的 promise。 */
export function delayedCancellableProvider(): CountingProvider {
  const wait = (signal?: AbortSignal): Promise<AnalysisProviderCallResult> =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) {
        reject(new AnalysisProviderError('CANCELLED_BY_USER', '分析已被用户取消'));
        return;
      }
      signal?.addEventListener(
        'abort',
        () => reject(new AnalysisProviderError('CANCELLED_BY_USER', '分析已被用户取消')),
        { once: true },
      );
    });
  return base((_self, signal) => wait(signal), (_self, signal) => wait(signal));
}

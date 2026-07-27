/**
 * V8-6 正式晋升「人工验收沙箱」运行时（仅供人工验收，绝不进入正式生产启动）。
 *
 * 完整复用 promotion:e2e 的 harness（临时 v8 库 + 确定性 seed + 双后端 + 前端 radar/recommendations
 * 开启），不复制整套 harness。仅在其上补：预建疑似关系的建议批次，令验收者打开页面即可
 * 直接点建议上的「晋升」，不必先手动生成批次。
 *
 * 绝不读取真实 API key、绝不访问外网、绝不连接或修改真实生产库（data/offerflow.sqlite3）。
 */
import { startPromotionE2E } from './harness';
import { readRuntime, type PromotionE2ERuntime } from './runtime';

/** 采集桥安全网关必需头（loopback 沙箱内的固定客户端标识）。 */
const CAPTURE_CLIENT_HEADER = { 'x-offerflow-capture-client': 'offerflow-promotion-review' };

export interface ManualReviewHandle {
  runtime: PromotionE2ERuntime;
  /** 预建建议批次的条数（验收者可直接在这些条目上点「晋升」）。 */
  recommendations: number;
  /** 关闭 Vite/Fastify、关闭数据库、删除临时库与 runtime 文件（复用 harness teardown）。 */
  stop: () => Promise<void>;
}

interface CreateBatchResponse {
  recommendationSet: { recommendations: Array<{ candidateVersionId: string }> };
}

/** 预建疑似关系 scope 的批次，使 review 页「加载最新批次」即可展示可晋升建议。 */
async function precreateBatch(runtime: PromotionE2ERuntime, scope: string[]): Promise<number> {
  const res = await fetch(`${runtime.apiUrl}/radar/recommendation-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CAPTURE_CLIENT_HEADER },
    body: JSON.stringify({ candidateVersionIds: scope }),
  });
  if (!res.ok) throw new Error(`预建建议批次失败：HTTP ${res.status}`);
  const body = (await res.json()) as CreateBatchResponse;
  return body.recommendationSet.recommendations.length;
}

export async function startManualReview(): Promise<ManualReviewHandle> {
  const stop = await startPromotionE2E();
  const runtime = readRuntime();
  // 用 API 候选作为 scope 预建一个批次；疑似关系两侧的建议仍可在页面上现场生成。
  const recommendations = await precreateBatch(runtime, runtime.apiCandidateVersionIds);
  return { runtime, recommendations, stop };
}

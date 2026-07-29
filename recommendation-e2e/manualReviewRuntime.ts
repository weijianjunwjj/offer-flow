/**
 * V8-5 岗位建议批次「人工验收沙箱」运行时（仅供人工验收，绝不进入正式生产启动）。
 *
 * 完整复用 recommendation:e2e 的 harness（临时 v8 库 + 确定性 seed 的评审 fixture/active
 * Resume/active JobMatchProfile + 疑似关系两侧 current 分析 + wide scope 8 可推荐/2 硬约束命中 +
 * 全开 radar/recommendations 后端门禁 + 前端 radar/recommendations 开启、analysis 关闭），不复制整套 harness。
 * 仅在其上补：预建 wide 批次（令「加载最新批次」可直接展示 blocked 场景），供 CLI 打印。
 *
 * 绝不读取真实 API key、绝不访问外网、绝不连接或修改真实生产库（data/offerflow.sqlite3）。
 */
import { startRecommendationE2E } from './harness';
import { readRuntime, type RecommendationE2ERuntime } from './runtime';

/** 采集桥安全网关必需头（loopback 沙箱内的固定客户端标识）。 */
const CAPTURE_CLIENT_HEADER = { 'x-offerflow-capture-client': 'offerflow-recommendation-review' };

export interface ManualReviewHandle {
  runtime: RecommendationE2ERuntime;
  /** 预建 wide 批次：selected 条数与 blocked 条数（供 banner 提示 blocked 场景已就绪）。 */
  wideBatch: { selected: number; blocked: number };
  /** 关闭 Vite/Fastify、关闭数据库、删除临时库与 runtime 文件（复用 harness teardown）。 */
  stop: () => Promise<void>;
}

interface CreateBatchResponse {
  selectedCandidateVersionIds: string[];
  recommendationSet: { blocked: Array<{ reason: string }> };
}

/**
 * 经真实 POST API 预建 wide scope 批次（8 可推荐 + 2 硬约束命中）。
 * wide scope 超出 review 页可见候选（≤2），只能经 API 生成；预建后「加载最新批次」即展示 blocked 场景。
 */
async function precreateWideBatch(runtime: RecommendationE2ERuntime): Promise<{ selected: number; blocked: number }> {
  const res = await fetch(`${runtime.apiUrl}/radar/recommendation-batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...CAPTURE_CLIENT_HEADER },
    body: JSON.stringify({ candidateVersionIds: runtime.wideScope }),
  });
  if (!res.ok) throw new Error(`预建 wide 批次失败：HTTP ${res.status}`);
  const body = (await res.json()) as CreateBatchResponse;
  return { selected: body.selectedCandidateVersionIds.length, blocked: body.recommendationSet.blocked.length };
}

/**
 * 启动人工验收沙箱：复用 harness 起真实 Fastify + Vite，预建 wide 批次，返回运行时信息与停机函数。
 * 停机函数即 harness 的 teardown：关闭服务、关闭 DB、删除临时库与 runtime 文件。
 */
export async function startManualReview(): Promise<ManualReviewHandle> {
  const stop = await startRecommendationE2E();
  const runtime = readRuntime();
  const wideBatch = await precreateWideBatch(runtime);
  return { runtime, wideBatch, stop };
}

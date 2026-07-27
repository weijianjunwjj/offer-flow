/**
 * V8-4 单岗位分析「人工验收沙箱」运行时（仅供人工验收，绝不进入正式生产启动）。
 *
 * 完整复用 analysis:e2e 的 harness（临时 v8 库 + 确定性 seed 的 Candidate/active Resume/
 * active JobMatchProfile + 闸门式 fake Provider + 全开的 radar/analysis 门禁 + 仅沙箱控制端点），
 * 不复制整套 harness。仅在其上补：读取运行时信息、查询当前 fake Provider 模式，供 CLI 打印。
 *
 * 绝不读取真实 API key、绝不访问外网、绝不连接或修改真实生产库（data/offerflow.sqlite3）。
 */
import { startAnalysisE2E } from './harness';
import { readRuntime, type AnalysisE2ERuntime } from './runtime';
import type { ProviderCounts } from './controllableProvider';

export interface ManualReviewHandle {
  runtime: AnalysisE2ERuntime;
  /** 当前 fake Provider 模式（来自只读安全计数端点）。 */
  mode: ProviderCounts['mode'];
  /** 关闭 Vite/Fastify、关闭数据库、删除临时库与 runtime 文件（复用 harness teardown）。 */
  stop: () => Promise<void>;
}

/** 查询仅沙箱只读计数端点，取当前 fake Provider 模式（不含任何 JD/简历/Prompt）。 */
async function readProviderMode(apiUrl: string): Promise<ProviderCounts['mode']> {
  const res = await fetch(`${apiUrl}/e2e/analysis-counts`);
  if (!res.ok) throw new Error(`读取 Provider 模式失败：HTTP ${res.status}`);
  return ((await res.json()) as ProviderCounts).mode;
}

/**
 * 启动人工验收沙箱：复用 harness 起真实 Fastify + Vite，返回运行时信息、当前模式与停机函数。
 * 停机函数即 harness 的 teardown：关闭服务、关闭 DB、删除临时库与 runtime 文件。
 */
export async function startManualReview(): Promise<ManualReviewHandle> {
  const stop = await startAnalysisE2E();
  const runtime = readRuntime();
  const mode = await readProviderMode(runtime.apiUrl);
  return { runtime, mode, stop };
}

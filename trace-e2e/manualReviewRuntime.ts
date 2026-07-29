/**
 * RC-11 反向追踪「人工验收沙箱」运行时（仅供人工验收，绝不进入正式生产启动）。
 *
 * 完整复用 trace:e2e 的 harness（临时 v8 库 + 确定性 seed + 前端 radar/recommendations 开启
 * + 预建覆盖各追踪场景的晋升 fixture），不复制整套 harness。
 *
 * 绝不读取真实 API key、绝不访问外网、绝不连接或修改真实生产库（data/offerflow.sqlite3）。
 */
import { startTraceE2E } from './harness';
import { readRuntime, type TraceE2ERuntime } from './runtime';

export interface ManualReviewHandle {
  runtime: TraceE2ERuntime;
  /** 关闭 Vite/Fastify、关闭数据库、删除临时库与 runtime 文件（复用 harness teardown）。 */
  stop: () => Promise<void>;
}

export async function startManualReview(): Promise<ManualReviewHandle> {
  const stop = await startTraceE2E();
  const runtime = readRuntime();
  return { runtime, stop };
}

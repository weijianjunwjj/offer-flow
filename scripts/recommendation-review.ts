/**
 * V8-5 岗位建议批次「人工验收沙箱」启动器（npm run recommendation:review）。
 *
 * 仅供人工验收：复用 recommendation:e2e harness（临时 v8 库 + 确定性 seed + 全开 radar/recommendations
 * 后端门禁 + 前端 radar/recommendations 开启、analysis 关闭 + 预建 wide 批次），起真实 Fastify + Vite
 * 并保持运行至 Ctrl+C。
 *
 * 严格边界：
 * - 绝不读取真实 API key、绝不访问外网；
 * - 绝不连接或修改 data/offerflow.sqlite3 或任何真实库；
 * - 不改动正式生产启动语义（server/index、npm run dev 均不受影响）；
 * - 不新增 migration、不改 package version；
 * - analysis 前端 flag 保持关闭，验证推荐面板独立于 V8-4 前端门禁。
 *
 * Ctrl+C（SIGINT）/SIGTERM 后：关闭 Vite/Fastify、关闭 DB、删除临时库与 runtime 文件。
 */
import { pathToFileURL } from 'node:url';
import { startManualReview, type ManualReviewHandle } from '../recommendation-e2e/manualReviewRuntime';

const TAG = '[建议验收沙箱]';

/** 打印人工验收入口、URL、临时库路径与三种场景（正常/0 条/blocked）的操作路径。 */
function printBanner(h: ManualReviewHandle): void {
  const { runtime, wideBatch } = h;
  const reviewPath = '/#/radar/review';
  console.log(`${TAG} ==========================================================`);
  console.log(`${TAG} V8-5 岗位建议批次人工验收沙箱已就绪（临时 v8 库，非真实生产库）`);
  console.log(`${TAG} 前端 URL           : ${runtime.webUrl}`);
  console.log(`${TAG} 后端 URL           : ${runtime.apiUrl}`);
  console.log(`${TAG} Radar Review 路径  : ${runtime.webUrl}${reviewPath}`);
  console.log(`${TAG} 临时数据库路径     : ${runtime.dbPath}`);
  console.log(`${TAG} 数据库 schema      : v8（沙箱临时库，应用最低要求 v6）`);
  console.log(`${TAG} 前端 flag          : radar=on / recommendations=on / analysis=off（推荐面板独立于 V8-4 门禁）`);
  console.log(`${TAG} ----------------------------------------------------------`);
  printScenarios(runtime, wideBatch);
  console.log(`${TAG} 按 Ctrl+C 停止：将关闭 Vite/Fastify、关闭 DB 并删除临时库与 runtime 文件。`);
  console.log(`${TAG} ==========================================================`);
}

/** 打印三种验收场景的点击路径：正常 1–8 条、0 条 emptyReason、blocked（硬约束命中）。 */
function printScenarios(runtime: ManualReviewHandle['runtime'], wideBatch: ManualReviewHandle['wideBatch']): void {
  console.log(`${TAG} 场景 A · 正常推荐（生成 2 条，apply_now 优先于 stretch）：`);
  console.log(`${TAG}   打开「待处理关系」列表 → 点击疑似重复关系 ${runtime.suspectedRelationId}`);
  console.log(`${TAG}   → 候选对比下方「岗位建议批次」面板 → 点「生成推荐批次」，展示 2 条（含理由/置信度/证据）。`);
  console.log(`${TAG} 场景 B · 0 条建议（展示 emptyReason=no_current_successful_analysis）：`);
  console.log(`${TAG}   点击 needs_recheck 关系 ${runtime.recheckRelationId}（两侧均无 current 分析）`);
  console.log(`${TAG}   → 面板自动清空上个关系的结果 → 点「生成推荐批次」，展示 0 条与原因码。`);
  console.log(`${TAG} 场景 C · blocked（8 条建议 + 2 条硬约束命中，已预建 wide 批次）：`);
  console.log(`${TAG}   预建 wide 批次：selected=${wideBatch.selected} 条、blocked=${wideBatch.blocked} 条（hard_constraint_hit）。`);
  console.log(`${TAG}   打开任一关系挂载面板 → 点「加载最新批次」，展示上述 wide 批次与 blocked 清单。`);
}

export async function main(): Promise<void> {
  const handle = await startManualReview();
  printBanner(handle);

  let closing = false;
  const teardown = (signal: string, exitCode: number): void => {
    if (closing) return;
    closing = true;
    console.log(`\n${TAG} 收到 ${signal}，正在关闭服务并清理临时库...`);
    handle
      .stop()
      .then(() => {
        console.log(`${TAG} 已关闭 Vite/Fastify、关闭数据库并删除临时库与 runtime 文件。`);
        // 不调用 process.exit()：Vite 的 watcher/esbuild async 句柄仍在收尾，强退会触发
        // libuv 断言（async.c）。设 exitCode 后让事件循环自然排空即可干净退出。
        process.exitCode = exitCode;
        // 兜底：若极少数情况下仍有句柄阻塞排空，2s 后强制退出（unref 不阻止正常自然退出）。
        setTimeout(() => process.exit(exitCode), 2000).unref();
      })
      .catch((error: unknown) => {
        console.error(`${TAG} 清理时出错：`, error);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => teardown('SIGINT', 130));
  process.once('SIGTERM', () => teardown('SIGTERM', 143));
  // Fastify + Vite 的监听句柄保持事件循环存活，进程将驻留直至上述信号触发。
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`${TAG} 启动失败：`, error);
    process.exitCode = 1;
  });
}

/**
 * V8-4 单岗位分析「人工验收沙箱」启动器（npm run analysis:review）。
 *
 * 仅供人工验收：复用 analysis:e2e harness（临时 v8 库 + 确定性 seed + 闸门式 fake Provider +
 * 全开 radar/analysis 门禁 + 仅沙箱控制端点），起真实 Fastify + Vite 并保持运行至 Ctrl+C。
 *
 * 严格边界：
 * - 绝不读取真实 API key、绝不访问外网；
 * - 绝不连接或修改 data/offerflow.sqlite3 或任何真实库；
 * - 不改动正式生产启动语义（server/index、npm run dev 均不受影响）；
 * - 不新增 migration、不改 package version；
 * - 仅沙箱控制端点只注册在本进程内，绝不出现在正式启动入口。
 *
 * Ctrl+C（SIGINT）/SIGTERM 后：关闭 Vite/Fastify、关闭 DB、删除临时库与 runtime 文件。
 */
import { pathToFileURL } from 'node:url';
import { startManualReview, type ManualReviewHandle } from '../analysis-e2e/manualReviewRuntime';

const TAG = '[分析验收沙箱]';

/** 打印人工验收入口、URL、临时库路径、当前 fake Provider 模式与仅沙箱控制端点用法。 */
function printBanner(h: ManualReviewHandle): void {
  const { runtime, mode } = h;
  const reviewPath = '/#/radar/review';
  const candidateId = runtime.fixture.materialCandidateId;
  console.log(`${TAG} ==========================================================`);
  console.log(`${TAG} V8-4 单岗位分析人工验收沙箱已就绪（临时 v8 库，非真实生产库）`);
  console.log(`${TAG} 前端 URL           : ${runtime.webUrl}`);
  console.log(`${TAG} 后端 URL           : ${runtime.apiUrl}`);
  console.log(`${TAG} Radar Review 路径  : ${runtime.webUrl}${reviewPath}`);
  console.log(`${TAG} 临时数据库路径     : ${runtime.dbPath}`);
  console.log(`${TAG} 数据库 schema      : v8（沙箱临时库，应用最低要求 v6）`);
  console.log(`${TAG} 当前 fake Provider 模式：${mode}`);
  console.log(`${TAG} ----------------------------------------------------------`);
  console.log(`${TAG} 打开 Radar Review → 点击 material_change feed 项 → 渲染单岗位分析面板`);
  console.log(`${TAG}   目标候选 materialCandidateId：${candidateId}`);
  printProviderControls(runtime.apiUrl);
  console.log(`${TAG} 按 Ctrl+C 停止：将关闭 Vite/Fastify、关闭 DB 并删除临时库与 runtime 文件。`);
  console.log(`${TAG} ==========================================================`);
}

/**
 * 打印「仅沙箱」控制端点用法：切换 fake Provider 模式并复位分析表，供人工走完
 * queued/running/succeeded/failed/retry/cancel/stale 各态。这些端点只在本沙箱进程内注册。
 */
function printProviderControls(apiUrl: string): void {
  console.log(`${TAG} ---- 仅沙箱控制端点（切换 fake Provider 模式；不影响正式入口）----`);
  console.log(`${TAG} 切换模式并清空分析表（reset + 设定模式），mode ∈ {`);
  console.log(`${TAG}   delayed_success | malformed_then_repair_success |`);
  console.log(`${TAG}   fail_once_then_success | delayed_cancellable }：`);
  console.log(`${TAG}   curl -X POST ${apiUrl}/e2e/reset-analysis -H "content-type: application/json" -d '{"mode":"<mode>"}'`);
  console.log(`${TAG} 释放闸门（让 running 的分析立即完成，用于观察 succeeded）：`);
  console.log(`${TAG}   curl -X POST ${apiUrl}/e2e/release-analysis`);
  console.log(`${TAG} 推进 active 画像版本（触发旧分析 stale 历史参考）：`);
  console.log(`${TAG}   curl -X POST ${apiUrl}/e2e/advance-profile-version`);
  console.log(`${TAG} 建议人工顺序：succeeded（delayed_success + 释放）→ malformed→repair →`);
  console.log(`${TAG}   failed→retry（fail_once_then_success）→ running→cancel（delayed_cancellable）→`);
  console.log(`${TAG}   刷新恢复 → stale（advance-profile-version 后重开候选）。`);
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

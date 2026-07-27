/**
 * V8-6 岗位建议晋升「人工验收沙箱」启动器（npm run promotion:review）。
 *
 * 仅供人工验收：复用 promotion:e2e harness（临时 v8 库 + 确定性 seed + 全开 radar/recommendations/
 * promotion 后端门禁 + 前端 radar/recommendations 开启，起真实 Fastify + Vite 并保持运行至 Ctrl+C。
 *
 * 严格边界：
 * - 绝不读取真实 API key、绝不访问外网；
 * - 绝不连接或修改 data/offerflow.sqlite3 或任何真实库；
 * - 不改动正式生产启动语义（server/index、npm run dev 均不受影响）；
 * - 不新增 migration、不改 package version；
 * - 前端不提供 jobId/applicationId 选择器：link 模式暂无用户入口（仅经 API 验证）。
 *
 * Ctrl+C（SIGINT）/SIGTERM 后：关闭 Vite/Fastify、关闭 DB、删除临时库与 runtime 文件。
 */
import { pathToFileURL } from 'node:url';
import { startManualReview, type ManualReviewHandle } from '../promotion-e2e/manualReviewRuntime';

const TAG = '[晋升验收沙箱]';

function printBanner(h: ManualReviewHandle): void {
  const { runtime } = h;
  const reviewPath = '/#/radar/review';
  console.log(`${TAG} ==========================================================`);
  console.log(`${TAG} V8-6 岗位建议晋升人工验收沙箱已就绪（临时 v8 库，非真实生产库）`);
  console.log(`${TAG} 前端 URL           : ${runtime.webUrl}`);
  console.log(`${TAG} 后端 URL           : ${runtime.apiUrl}`);
  console.log(`${TAG} Radar Review 路径  : ${runtime.webUrl}${reviewPath}`);
  console.log(`${TAG} 临时数据库路径     : ${runtime.dbPath}`);
  console.log(`${TAG} 前端 flag          : radar=on / recommendations=on（晋升面板随建议门禁）`);
  console.log(`${TAG} ----------------------------------------------------------`);
  printScenarios(runtime);
  console.log(`${TAG} 按 Ctrl+C 停止：将关闭 Vite/Fastify、关闭 DB 并删除临时库与 runtime 文件。`);
  console.log(`${TAG} ==========================================================`);
}

/** 打印各验收场景的点击路径：create 全链路 / 钳制 / 幂等 / 禁止晋升 / link（仅 API）。 */
function printScenarios(runtime: ManualReviewHandle['runtime']): void {
  const cv = runtime.apiCandidateVersionIds;
  console.log(`${TAG} 场景 A · create 全链路（预览 → 确认）：`);
  console.log(`${TAG}   打开「待处理关系」列表 → 点疑似重复关系 ${runtime.suspectedRelationId}`);
  console.log(`${TAG}   → 「岗位建议」面板点「生成推荐批次」→ 任一建议条目点「晋升」`);
  console.log(`${TAG}   → 「晋升为正式记录」面板点「预览晋升计划」（此时零写入）→ 再点「确认晋升」`);
  console.log(`${TAG}   → 展示 岗位/投递/反馈事件/晋升记录 四个正式对象 ID。`);
  console.log(`${TAG} 场景 B · 深度钳制（请求 feedback，实际只到 job_only）：`);
  console.log(`${TAG}   同上打开晋升面板 → 触发原因选「仅标记为重点关注」→ 深度选「建岗位 + 投递 + 反馈事件」`);
  console.log(`${TAG}   → 预览：显示橙色钳制提示 + 「该触发原因不足以创建投递，已降到仅建岗位」。`);
  console.log(`${TAG} 场景 C · 幂等（已晋升过不会再建一份）：`);
  console.log(`${TAG}   对场景 A 已确认过的同一条建议再点「晋升」→「预览晋升计划」`);
  console.log(`${TAG}   → 显示「此候选已晋升过，确认不会再建一份正式记录」。`);
  console.log(`${TAG} 场景 D · 禁止晋升（no_response）：`);
  console.log(`${TAG}   UI 刻意不提供该选项（无回复不构成晋升依据）；如需验证请直接调 API：`);
  console.log(`${TAG}   curl -X POST ${runtime.apiUrl}/radar/candidate-versions/${cv[3] ?? '<cv>'}/promotions/preview \\`);
  console.log(`${TAG}     -H 'content-type: application/json' -H 'x-offerflow-capture-client: offerflow-promotion-review' \\`);
  console.log(`${TAG}     -d '{"trigger":"no_response","requestedDepth":"feedback"}'  → 预期 409。`);
  console.log(`${TAG} 场景 E · link 模式（关联既有岗位）——**暂无 UI 入口**：`);
  console.log(`${TAG}   服务只在请求显式带 jobId 时才 link，前端尚未提供岗位选择器，故只能经 API 验证：`);
  console.log(`${TAG}   先对 ${cv[0] ?? '<cv>'} 以 {"trigger":"user_priority","requestedDepth":"job_only"} 建出 Job，`);
  console.log(`${TAG}   再对 ${cv[1] ?? '<cv>'} 预览时带上该 jobId → 预期 jobMode=link 且 jobs 不新增。`);
  console.log(`${TAG} 已预建建议批次：${runtime.apiCandidateVersionIds.length} 个 API 候选在 scope 内（可用「加载最新批次」查看）。`);
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
        setTimeout(() => process.exit(exitCode), 2000).unref();
      })
      .catch((error: unknown) => {
        console.error(`${TAG} 清理时出错：`, error);
        process.exit(1);
      });
  };
  process.once('SIGINT', () => teardown('SIGINT', 130));
  process.once('SIGTERM', () => teardown('SIGTERM', 143));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(`${TAG} 启动失败：`, error);
    process.exitCode = 1;
  });
}

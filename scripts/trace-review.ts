/**
 * RC-11 岗位晋升反向追踪「人工验收沙箱」启动器（npm run trace:review）。
 *
 * 仅供人工验收：复用 trace:e2e harness（临时 v8 库 + 确定性 seed + 全开 radar/recommendations/
 * promotion 后端门禁 + 前端 radar/recommendations 开启），起真实 Fastify + Vite 并保持运行至 Ctrl+C。
 * 已预建覆盖各追踪场景的晋升 fixture，验收者打开页面/调 API 即可逐项核对。
 *
 * 严格边界：
 * - 绝不读取真实 API key、绝不访问外网；
 * - 绝不连接或修改 data/offerflow.sqlite3 或任何真实库；
 * - 不改动正式生产启动语义（server/index、npm run dev 均不受影响）；
 * - 不新增 migration、不改 package version；
 * - 追踪面板纯只读：无删除/修改/自动修复任何入口。
 *
 * Ctrl+C（SIGINT）/SIGTERM 后：关闭 Vite/Fastify、关闭 DB、删除临时库与 runtime 文件。
 */
import { pathToFileURL } from 'node:url';
import { startManualReview, type ManualReviewHandle } from '../trace-e2e/manualReviewRuntime';

const TAG = '[追踪验收沙箱]';

function printBanner(h: ManualReviewHandle): void {
  const { runtime } = h;
  console.log(`${TAG} ==========================================================`);
  console.log(`${TAG} RC-11 岗位晋升反向追踪人工验收沙箱已就绪（临时 v8 库，非真实生产库）`);
  console.log(`${TAG} 前端 URL           : ${runtime.webUrl}`);
  console.log(`${TAG} 后端 URL           : ${runtime.apiUrl}`);
  console.log(`${TAG} Radar Review 路径  : ${runtime.webUrl}/#/radar/review`);
  console.log(`${TAG} 临时数据库路径     : ${runtime.dbPath}`);
  console.log(`${TAG} 前端 flag          : radar=on / recommendations=on（追踪面板随晋升面板）`);
  console.log(`${TAG} ----------------------------------------------------------`);
  printScenarios(runtime);
  console.log(`${TAG} 按 Ctrl+C 停止：将关闭 Vite/Fastify、关闭 DB 并删除临时库与 runtime 文件。`);
  console.log(`${TAG} ==========================================================`);
}

/** 打印各追踪验收场景的核对路径（正向 UI 链 + 反查区 + 各状态 fixture id）。 */
function printScenarios(runtime: ManualReviewHandle['runtime']): void {
  const f = runtime.fixtures;
  console.log(`${TAG} 场景 A · 正向来源链（UI）：`);
  console.log(`${TAG}   打开「待处理关系」→ 点疑似关系 ${runtime.suspectedRelationId} →「生成推荐批次」`);
  console.log(`${TAG}   → 任一建议点「晋升」→「预览」→「确认晋升」→ 面板下方「晋升来源追溯」自动展示`);
  console.log(`${TAG}   候选版本 / 触发原因 / 推荐批次（按成员关系推断）/ 正式对象。`);
  console.log(`${TAG} 场景 B · 三类正式对象反查（UI「反查正式对象来源」区）：`);
  console.log(`${TAG}   选「岗位」输入 ${f.withTrigger.jobId} → 反查（link 模式应显示多条）。`);
  console.log(`${TAG}   选「投递」输入 ${f.noTrigger.applicationId ?? '<app>'} → 单条。`);
  console.log(`${TAG}   选「反馈事件」输入 ${f.noTrigger.feedbackEventId ?? '<ev>'} → 单条。`);
  console.log(`${TAG} 场景 C · 触发四态：`);
  console.log(`${TAG}   未记录：晋升 ${f.noTrigger.promotionId}（trigger=未记录）；`);
  console.log(`${TAG}   已撤销：晋升 ${f.reverted.promotionId}（显示「已撤销，但正式事实链路保留」）。`);
  console.log(`${TAG} 场景 D · 批次成员推断：`);
  console.log(`${TAG}   入选：${f.selectedInBatch ? f.selectedInBatch.candidateVersionId : '（本次 seed 无入选样本）'}（wasSelected=进入建议）；`);
  console.log(`${TAG}   仅覆盖：${f.coveredOnlyInBatch ? f.coveredOnlyInBatch.candidateVersionId : '（本次 seed 无仅覆盖样本）'}（wasSelected=仅在 scope 内）。`);
  console.log(`${TAG} 场景 E · 无来源明确不可追溯：`);
  console.log(`${TAG}   反查「岗位」输入 ${f.untraceableJobId} → 显示「不可追溯」。`);
  console.log(`${TAG} 场景 F · 只读：追踪面板不含删除/修改/自动修复任何按钮（仅呈现）。`);
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

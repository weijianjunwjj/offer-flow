/**
 * RC-10 雷达动作「人工验收沙箱」启动器（npm run action:review）。
 *
 * 仅供人工验收：复用 action:e2e harness（临时 v8 库 + 确定性 seed + radar/recommendations 后端门禁
 * + 前端 radar/recommendations 开启），起真实 Fastify + Vite 并保持运行至 Ctrl+C。
 *
 * 严格边界：
 * - 绝不读取真实 API key、绝不访问外网；
 * - 绝不连接或修改 data/offerflow.sqlite3 或任何真实库；
 * - 不改动正式生产启动语义（server/index、npm run dev 均不受影响）；
 * - 不新增 migration、不改 package version、不新增生产开关。
 *
 * Ctrl+C（SIGINT）/SIGTERM 后：关闭 Vite/Fastify、关闭 DB、删除临时库与 runtime 文件。
 */
import { pathToFileURL } from 'node:url';
import { startManualReview, type ManualReviewHandle } from '../action-e2e/manualReviewRuntime';

const TAG = '[动作验收沙箱]';

function printBanner(h: ManualReviewHandle): void {
  const { runtime } = h;
  const reviewPath = '/#/radar/review';
  console.log(`${TAG} ==========================================================`);
  console.log(`${TAG} RC-10 岗位雷达动作人工验收沙箱已就绪（临时 v8 库，非真实生产库）`);
  console.log(`${TAG} 前端 URL           : ${runtime.webUrl}`);
  console.log(`${TAG} 后端 URL           : ${runtime.apiUrl}`);
  console.log(`${TAG} Radar Review 路径  : ${runtime.webUrl}${reviewPath}`);
  console.log(`${TAG} 临时数据库路径     : ${runtime.dbPath}`);
  console.log(`${TAG} 前端 flag          : radar=on / recommendations=on（动作栏随评审工作台渲染）`);
  console.log(`${TAG} 预建建议批次       : ${h.recommendations} 条（疑似关系两侧 scope）`);
  console.log(`${TAG} ----------------------------------------------------------`);
  printScenarios(runtime);
  console.log(`${TAG} 按 Ctrl+C 停止：将关闭 Vite/Fastify、关闭 DB 并删除临时库与 runtime 文件。`);
  console.log(`${TAG} ==========================================================`);
}

/** 打印各验收场景的点击路径：四族切换 / 刷新恢复 / 撤销恢复 / 推荐排除 / 已晋升不变。 */
function printScenarios(runtime: ManualReviewHandle['runtime']): void {
  console.log(`${TAG} 场景 A · 四族一键切换：`);
  console.log(`${TAG}   打开「待处理关系」→ 点疑似重复关系 ${runtime.suspectedRelationId}`);
  console.log(`${TAG}   → 候选 A/B 两卡各有动作栏：收藏 / 忽略 / 标记优先 / 已投待反馈`);
  console.log(`${TAG}   → 点任一族置位后显示生效态标签与「撤销」入口。`);
  console.log(`${TAG} 场景 B · 刷新后状态恢复：`);
  console.log(`${TAG}   置位任一族后刷新页面（F5）→ 重新点开该关系 → 生效态仍在（服务端事件流恢复）。`);
  console.log(`${TAG} 场景 C · 撤销后状态恢复：`);
  console.log(`${TAG}   在生效态上点「撤销」→ 回到未生效、set 按钮重现。`);
  console.log(`${TAG} 场景 D · 忽略/待反馈影响推荐资格：`);
  console.log(`${TAG}   「岗位建议」面板点「加载最新批次」（已预建）→ 记下条数`);
  console.log(`${TAG}   → 对某侧候选点「忽略」→ 建议区立即清空 → 再点「生成推荐批次」`);
  console.log(`${TAG}   → 该候选进入「被排除的候选」（ignored_unchanged）；撤销忽略后重新生成即恢复。`);
  console.log(`${TAG}   → 收藏 / 标记优先不会排除候选（重新生成仍在建议内）。`);
  console.log(`${TAG} 场景 E · 已晋升候选正式事实不变（经 API 验证，无 UI 入口）：`);
  console.log(`${TAG}   已晋升候选 id=${runtime.promotedCandidateId}（seed 阶段已写 1 份正式对象）。`);
  console.log(`${TAG}   对它执行/撤销任意动作后，Job/Application/FeedbackEvent/Promotion 均不变。示例：`);
  console.log(`${TAG}   curl -X POST ${runtime.apiUrl}/radar/actions/apply \\`);
  console.log(`${TAG}     -H 'content-type: application/json' -H 'x-offerflow-capture-client: offerflow-action-review' \\`);
  console.log(`${TAG}     -d '{"candidateId":"${runtime.promotedCandidateId}","family":"save"}'`);
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

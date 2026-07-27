import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 轻量运行时契约：Playwright worker 只读此文件，不加载 Vite/Fastify。 */
export const RUNTIME_DIR = path.join(os.tmpdir(), 'offerflow-promotion-e2e');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

/** 晋升前基线：正式对象计数。晋升是唯一允许写这些表的路径，故计数变化即可归因。 */
export interface PromotionE2EBaseline {
  jobs: number;
  applications: number;
  feedbackEvents: number;
  promotions: number;
}

export interface PromotionE2ERuntime {
  /** flag：radar + recommendations 开启（晋升 UI 随建议门禁）。 */
  webUrl: string;
  /** v8 后端直连 URL：worker 用于命中真实晋升 API 与只读断言。 */
  apiUrl: string;
  /**
   * 专用于原子性用例的后端：与主后端共库，但注入会撞主键的 createId，
   * 使 Promotion 落库必失败——用于验证"已写的 Job/Application/事件全部回滚"。
   */
  atomicApiUrl: string;
  dbPath: string;
  /** 疑似重复关系（scope=2，两侧均 seed current 分析）：UI 生成建议 → 可点晋升。 */
  suspectedRelationId: string;
  /**
   * 供 API 直接驱动的候选版本（不经 UI）：link / 钳制 / no_response / 幂等 / 原子性用例各取一个。
   *
   * link 模式**没有** UI 入口：服务只在前端显式指认 `jobId` 时才 link，
   * 不按 company/role 自动匹配既有 Job（见 promotionPlan.targetPlan）。故 link 只经 API 验证。
   */
  apiCandidateVersionIds: string[];
  baseline: PromotionE2EBaseline;
}

export function readRuntime(): PromotionE2ERuntime {
  return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as PromotionE2ERuntime;
}

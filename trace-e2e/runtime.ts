import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 轻量运行时契约：Playwright worker 只读此文件，不加载 Vite/Fastify。 */
export const RUNTIME_DIR = path.join(os.tmpdir(), 'offerflow-trace-e2e');
export const RUNTIME_FILE = path.join(RUNTIME_DIR, 'runtime.json');

/** 一条晋升 fixture 的正式对象与来源锚点。 */
export interface PromotionFixture {
  promotionId: string;
  candidateVersionId: string;
  jobId: string;
  applicationId: string | null;
  feedbackEventId: string | null;
}

export interface TraceE2EFixtures {
  /** feedback 深度 + 留有触发动作（trigger 解析为 resolved、未撤销）。 */
  withTrigger: PromotionFixture & { triggerActionId: string };
  /** feedback 深度、无触发动作（trigger=not_recorded）。 */
  noTrigger: PromotionFixture;
  /** 触发动作事后被撤销（trigger=resolved 且 reverted=true；正式事实链路保留）。 */
  reverted: PromotionFixture & { triggerActionId: string };
  /** link 模式：同一 Job 被两份晋升引用（反查返回多条）。 */
  linkJobId: string;
  linkPromotionIds: string[];
  /** 该候选版本进入推荐批次的最终建议（wasSelected=true）——按 DB 实测归类。 */
  selectedInBatch: { candidateVersionId: string; batchKey: string } | null;
  /** 仅被批次 scope 覆盖、未进入建议（wasSelected=false）——按 DB 实测归类。 */
  coveredOnlyInBatch: { candidateVersionId: string; batchKey: string } | null;
  /** 任意无晋升引用的正式对象 id（反查应明确不可追溯）。 */
  untraceableJobId: string;
}

export interface TraceE2ERuntime {
  webUrl: string;
  apiUrl: string;
  dbPath: string;
  /** review 页疑似关系：UI 生成建议 → 点晋升 → 展示来源链。 */
  suspectedRelationId: string;
  fixtures: TraceE2EFixtures;
}

export function readRuntime(): TraceE2ERuntime {
  return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8')) as TraceE2ERuntime;
}

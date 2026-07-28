/**
 * RC-11 反向追踪 E2E harness（进程内，动态端口，自动清理）。
 *
 * 复用 promotion-e2e/harness 起全部服务（临时 v8 库 + 确定性 seed + 前端 radar/recommendations 开启），
 * 不复制第二份。在其上仅用**真实 HTTP API** 预建覆盖各追踪场景的晋升 fixture：
 * - withTrigger：feedback + 留触发动作（trigger=resolved）；
 * - noTrigger：feedback 无触发动作（trigger=not_recorded）；
 * - reverted：留触发动作后撤销（trigger=resolved 且 reverted，正式事实链路保留）；
 * - link：同一 Job 被两份晋升引用（反查多条）；
 * - 批次成员：预建批次覆盖候选版本，按 DB 实测把候选分成 selected / covered-only。
 *
 * fixture 全部经晋升产生；action_missing 因 trigger_action_id FK ON DELETE RESTRICT
 * 无法自然构造，交由服务/组件单测覆盖（不在 E2E 伪造孤儿）。
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { startPromotionE2E } from '../promotion-e2e/harness';
import { readRuntime as readPromotionRuntime } from '../promotion-e2e/runtime';
import { RUNTIME_DIR, RUNTIME_FILE, type PromotionFixture, type TraceE2ERuntime } from './runtime';

const H = { 'content-type': 'application/json', 'x-offerflow-capture-client': 'offerflow-trace-e2e' };

async function post(apiUrl: string, path: string, body: unknown): Promise<any> {
  const res = await fetch(`${apiUrl}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const promote = (apiUrl: string, cv: string, body: unknown) =>
  post(apiUrl, `/radar/candidate-versions/${cv}/promotions`, body);

/** 用只读连接把 candidateVersionId 映射到 candidateId（apply 动作需要 candidateId）。 */
function candidateIdOf(dbPath: string, versionId: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT candidate_id FROM radar_candidate_versions WHERE id = ?').get(versionId) as { candidate_id: string } | undefined;
    if (row === undefined) throw new Error(`找不到候选版本 ${versionId}`);
    return row.candidate_id;
  } finally { db.close(); }
}

/** apply 一个 priority 动作，返回其 actionId（最新 set 事件）。 */
async function applyPriority(apiUrl: string, candidateId: string): Promise<string> {
  const result = await post(apiUrl, '/radar/actions/apply', { candidateId, family: 'priority' });
  const setEntry = [...result.view.history].reverse().find((h: { isSet: boolean }) => h.isSet);
  if (setEntry === undefined) throw new Error('apply priority 未产生 set 事件');
  return setEntry.actionId as string;
}

const toFixture = (cv: string, resp: any): PromotionFixture => ({
  promotionId: resp.promotion.id, candidateVersionId: cv,
  jobId: resp.promotion.jobId, applicationId: resp.promotion.applicationId,
  feedbackEventId: resp.promotion.feedbackEventId,
});

/** 预建一个覆盖给定候选版本的批次，返回其 batchKey 与实际入选的候选版本集合。 */
async function precreateBatch(apiUrl: string, dbPath: string, scope: string[]): Promise<{ batchKey: string; selected: Set<string> }> {
  await post(apiUrl, '/radar/recommendation-batches', { candidateVersionIds: scope });
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare(
      'SELECT batch_key, selected_candidate_version_ids_json AS sel FROM radar_recommendation_batches ORDER BY generated_at DESC, id DESC LIMIT 1',
    ).get() as { batch_key: string; sel: string };
    return { batchKey: row.batch_key, selected: new Set(JSON.parse(row.sel) as string[]) };
  } finally { db.close(); }
}

export async function startTraceE2E(): Promise<() => Promise<void>> {
  const stopPromotion = await startPromotionE2E();
  try {
    const base = readPromotionRuntime();
    const { apiUrl, dbPath } = base;
    const cv = base.apiCandidateVersionIds;

    // 批次先建（覆盖全部 API 候选），据此把候选分为 selected / covered-only。
    const batch = await precreateBatch(apiUrl, dbPath, cv);

    // withTrigger：cv[0] user_priority job_only + 留触发动作 → 同时作为 link 的既有 Job。
    const trigA = await applyPriority(apiUrl, candidateIdOf(dbPath, cv[0]!));
    const p0 = await promote(apiUrl, cv[0]!, { trigger: 'user_priority', requestedDepth: 'job_only', triggerActionId: trigA });
    const withTrigger = { ...toFixture(cv[0]!, p0), triggerActionId: trigA };

    // link：cv[1] feedback 显式指认 withTrigger.jobId → 同一 Job 被两份晋升引用。
    const p1 = await promote(apiUrl, cv[1]!, { trigger: 'hr_replied', requestedDepth: 'feedback', jobId: withTrigger.jobId });

    // noTrigger：cv[2] feedback，无触发动作 → trigger=not_recorded。
    const p2 = await promote(apiUrl, cv[2]!, { trigger: 'hr_replied', requestedDepth: 'feedback' });

    // reverted：cv[3] 留触发动作 → 晋升 → 撤销该动作（正式事实链路保留）。
    const trigB = await applyPriority(apiUrl, candidateIdOf(dbPath, cv[3]!));
    const p3 = await promote(apiUrl, cv[3]!, { trigger: 'user_priority', requestedDepth: 'job_only', triggerActionId: trigB });
    await post(apiUrl, '/radar/actions/revert', { candidateId: candidateIdOf(dbPath, cv[3]!), family: 'priority' });

    const classify = (versionId: string, key: string) => ({ candidateVersionId: versionId, batchKey: key });
    const selectedCv = cv.find((v) => batch.selected.has(v));
    const coveredCv = cv.find((v) => !batch.selected.has(v));

    const runtime: TraceE2ERuntime = {
      webUrl: base.webUrl, apiUrl, dbPath, suspectedRelationId: base.suspectedRelationId,
      fixtures: {
        withTrigger,
        noTrigger: toFixture(cv[2]!, p2),
        reverted: { ...toFixture(cv[3]!, p3), triggerActionId: trigB },
        linkJobId: withTrigger.jobId,
        linkPromotionIds: [withTrigger.promotionId, p1.promotion.id],
        selectedInBatch: selectedCv ? classify(selectedCv, batch.batchKey) : null,
        coveredOnlyInBatch: coveredCv ? classify(coveredCv, batch.batchKey) : null,
        untraceableJobId: 'job-created-outside-radar-xyz',
      },
    };
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify(runtime, null, 2), 'utf8');
    return stopTraceE2E(stopPromotion);
  } catch (error) {
    await stopPromotion();
    throw error;
  }
}

function stopTraceE2E(stopPromotion: () => Promise<void>): () => Promise<void> {
  return async () => {
    try { fs.rmSync(RUNTIME_FILE, { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(RUNTIME_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    await stopPromotion();
  };
}

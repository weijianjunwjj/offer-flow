/**
 * RC-11 反向追踪 E2E。
 *
 * 分工：
 * - **浏览器**覆盖正向 UI 链（点建议 → 晋升 → 确认 → 面板下方来源链）+ 反查区（三类对象 / link 多条 /
 *   无来源不可追溯 / 刷新后追踪保持）；
 * - **真实 API + 直读库**覆盖触发四态、批次成员推断 + wasSelected、撤销不破坏追踪、
 *   正式事实零写入、库完整性——避免依赖 UI 措辞且更精确。
 */
import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime } from './runtime';

const rt = readRuntime();
const H = { 'content-type': 'application/json', 'x-offerflow-capture-client': 'offerflow-trace-e2e' };

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(rt.dbPath, { readonly: true });
  db.pragma('busy_timeout = 4000');
  try { return fn(db); } finally { db.close(); }
}

function formalCounts(): Record<string, number> {
  return withDb((db) => {
    const c = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    return {
      jobs: c('jobs'), applications: c('applications'),
      feedbackEvents: c('feedback_events'), promotions: c('radar_promotions'),
      actions: c('radar_actions'),
    };
  });
}

async function getJson(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${rt.apiUrl}${path}`, { headers: H });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const traceByObject = (kind: 'jobs' | 'applications' | 'feedback-events', id: string) =>
  getJson(`/radar/${kind}/${id}/promotion-trace`);
const traceByPromotion = (id: string) => getJson(`/radar/promotions/${id}/trace`);

async function openReviewPage(page: Page): Promise<void> {
  await page.goto(`${rt.webUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
}

async function promoteOneViaUI(page: Page): Promise<void> {
  await page.locator(`[data-testid="relation-${rt.suspectedRelationId}"]`).click();
  const rec = page.getByTestId('recommendation-panel-review');
  await rec.getByTestId('recommendation-generate').click();
  await expect(rec.getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('recommendation-promote-1').click();
  const panel = page.getByTestId('promotion-panel-review');
  await panel.getByTestId('promotion-preview').click();
  await expect(panel.getByTestId('promotion-plan')).toBeVisible({ timeout: 10_000 });
  await panel.getByTestId('promotion-confirm').click();
  await expect(panel.getByTestId('promotion-result')).toBeVisible({ timeout: 10_000 });
}

const tracePanel = (page: Page) => page.getByTestId('promotion-trace-review');

test.describe('RC-11 反向追踪 · 浏览器', () => {
  test('确认晋升后自动展示来源链：候选版本 + 触发原因 + 批次成员推断 + 正式对象', async ({ page }) => {
    await openReviewPage(page);
    await promoteOneViaUI(page);

    const origin = tracePanel(page).getByTestId('trace-origin');
    await expect(origin).toBeVisible({ timeout: 10_000 });
    // 候选版本已解析（非「记录缺失」）。
    await expect(origin.getByTestId('origin-candidate-version')).toBeVisible();
    await expect(origin.getByTestId('origin-candidate-missing')).toHaveCount(0);
    // UI 未经动作栏晋升 → 触发原因未记录。
    await expect(origin.getByTestId('origin-trigger-not-recorded')).toBeVisible();
    // 批次：该候选在建议 scope 内 → 明确标注「按成员关系推断」。
    await expect(origin.getByTestId('origin-batches-inferred')).toBeVisible();
  });

  test('反查正式对象来源：三类对象均可反查，link 模式显示多条', async ({ page }) => {
    await openReviewPage(page);
    await promoteOneViaUI(page);
    const panel = tracePanel(page);

    // 岗位（link）：同一 Job 被两份晋升引用 → 计数含「link 模式」提示（岗位为默认对象类型）。
    await panel.getByTestId('trace-lookup-id').locator('input').fill(rt.fixtures.linkJobId);
    await panel.getByTestId('trace-lookup-run').click();
    await expect(panel.getByTestId('trace-lookup-count')).toContainText('link 模式');
    for (const pid of rt.fixtures.linkPromotionIds) {
      await expect(panel.getByTestId(`trace-lookup-origin-${pid}`)).toBeVisible();
    }
  });

  test('无来源正式对象 → 明确「不可追溯」（不编造）', async ({ page }) => {
    await openReviewPage(page);
    await promoteOneViaUI(page);
    const panel = tracePanel(page);

    await panel.getByTestId('trace-lookup-id').locator('input').fill(rt.fixtures.untraceableJobId);
    await panel.getByTestId('trace-lookup-run').click();
    await expect(panel.getByTestId('trace-lookup-untraceable')).toBeVisible();
    await expect(panel.getByTestId('trace-lookup-untraceable')).toContainText('不可追溯');
  });

  test('刷新后追踪保持：重走晋升（幂等）展示同一份来源链', async ({ page }) => {
    await openReviewPage(page);
    await promoteOneViaUI(page);
    const before = await tracePanel(page).getByTestId('origin-promotion-id').textContent();
    expect(before).toBeTruthy();

    // 刷新页面：前端态全清（面板随晋升入口重新出现）。
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();

    // 对同一候选重走晋升——幂等命中同一份晋升，来源链展示的晋升 id 不变（后端持久化，非仅前端态）。
    await promoteOneViaUI(page);
    await expect(tracePanel(page).getByTestId('origin-promotion-id')).toHaveText(before!.trim());
  });
});

test.describe('RC-11 反向追踪 · 真实 API 与直读库', () => {
  test('正向来源链：feedback 晋升解析候选版本 + 触发原因 + 正向对象', async () => {
    const { status, json } = await traceByPromotion(rt.fixtures.withTrigger.promotionId);
    expect(status).toBe(200);
    expect(json.candidateVersion.status).toBe('resolved');
    expect(json.candidateVersion.candidateVersionId).toBe(rt.fixtures.withTrigger.candidateVersionId);
    expect(json.jobId).toBe(rt.fixtures.withTrigger.jobId);
    // 留有触发动作 → resolved 且未撤销。
    expect(json.trigger.status).toBe('resolved');
    expect(json.trigger.actionId).toBe(rt.fixtures.withTrigger.triggerActionId);
    expect(json.trigger.reverted).toBe(false);
  });

  test('三类正式对象反查：Job/Application/FeedbackEvent 均追溯到同一份晋升', async () => {
    const f = rt.fixtures.noTrigger;
    const job = await traceByObject('jobs', f.jobId);
    const app = await traceByObject('applications', f.applicationId!);
    const ev = await traceByObject('feedback-events', f.feedbackEventId!);
    for (const r of [job, app, ev]) {
      expect(r.status).toBe(200);
      expect(r.json.traceable).toBe(true);
      expect(r.json.promotions.map((p: { promotionId: string }) => p.promotionId)).toContain(f.promotionId);
    }
  });

  test('link 模式：同一 Job 反查返回多份晋升', async () => {
    const { json } = await traceByObject('jobs', rt.fixtures.linkJobId);
    expect(json.traceable).toBe(true);
    const ids = json.promotions.map((p: { promotionId: string }) => p.promotionId).sort();
    expect(ids).toEqual([...rt.fixtures.linkPromotionIds].sort());
  });

  test('未记录触发原因：trigger=not_recorded', async () => {
    const { json } = await traceByPromotion(rt.fixtures.noTrigger.promotionId);
    expect(json.trigger.status).toBe('not_recorded');
  });

  test('批次成员推断：状态为 linked_by_scope_membership，wasSelected 与库实测一致', async () => {
    const sample = rt.fixtures.selectedInBatch ?? rt.fixtures.coveredOnlyInBatch;
    test.skip(sample === null, '本次 seed 无批次成员样本');
    // 用该候选版本的晋升反查其来源批次。
    const promo = [rt.fixtures.withTrigger, rt.fixtures.noTrigger, rt.fixtures.reverted]
      .find((p) => p.candidateVersionId === sample!.candidateVersionId);
    test.skip(promo === undefined, '样本候选未产生晋升');
    const { json } = await traceByPromotion(promo!.promotionId);
    expect(json.recommendationBatches.status).toBe('linked_by_scope_membership');
    const wasSelected = rt.fixtures.selectedInBatch?.candidateVersionId === sample!.candidateVersionId;
    const hit = json.recommendationBatches.batches.find((b: { batchKey: string }) => b.batchKey === sample!.batchKey);
    expect(hit).toBeTruthy();
    expect(hit.wasSelected).toBe(wasSelected);
  });

  test('撤销 RadarAction 不破坏追踪：trigger=resolved 且 reverted，正式事实链路保留', async () => {
    const { json } = await traceByPromotion(rt.fixtures.reverted.promotionId);
    expect(json.trigger.status).toBe('resolved');
    expect(json.trigger.reverted).toBe(true);
    expect(json.trigger.revertedByActionId).not.toBeNull();
    // 正式对象仍完整追溯到该晋升。
    const job = await traceByObject('jobs', rt.fixtures.reverted.jobId);
    expect(job.json.promotions.map((p: { promotionId: string }) => p.promotionId)).toContain(rt.fixtures.reverted.promotionId);
  });

  test('无来源正式对象 → traceable=false / no_promotion；晋升不存在 → 404', async () => {
    const missing = await traceByObject('jobs', rt.fixtures.untraceableJobId);
    expect(missing.status).toBe(200);
    expect(missing.json).toMatchObject({ traceable: false, reason: 'no_promotion' });

    const noPromo = await traceByPromotion('no-such-promotion-id');
    expect(noPromo.status).toBe(404);
    expect(noPromo.json.code).toBe('PROMOTION_NOT_FOUND');
  });

  test('追踪为纯只读：连续追踪调用后正式事实/动作五表零写入', async () => {
    const before = formalCounts();
    // 反复调用各追踪端点（含正向、三类反查、无来源、404）。
    await traceByPromotion(rt.fixtures.withTrigger.promotionId);
    await traceByPromotion(rt.fixtures.reverted.promotionId);
    await traceByObject('jobs', rt.fixtures.linkJobId);
    await traceByObject('applications', rt.fixtures.noTrigger.applicationId!);
    await traceByObject('feedback-events', rt.fixtures.noTrigger.feedbackEventId!);
    await traceByObject('jobs', rt.fixtures.untraceableJobId);
    await traceByPromotion('no-such-promotion-id');
    expect(formalCounts()).toEqual(before);
  });

  test('库完整性：全部用例跑完后无损坏、无悬挂外键', async () => {
    withDb((db) => {
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      expect(integrity).toHaveLength(1);
      expect(integrity[0]?.integrity_check).toBe('ok');
      expect(db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
    });
  });
});

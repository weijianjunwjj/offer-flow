/**
 * V8-6 正式晋升 E2E。
 *
 * 分工（第四波裁决）：
 * - **浏览器**覆盖 create 模式全链路：点建议上的「晋升」→ 预览（零写入）→ 确认 → 展示正式对象 ID → 刷新后仍显示已晋升；
 * - **真实 API** 覆盖 link 模式：服务只在前端显式指认 jobId 时才 link，而 UI 目前不提供
 *   jobId/applicationId 选择器，故 link 无法经浏览器触达（link 计划的 UI 展示由组件测试覆盖）；
 * - 深度钳制 / no_response / 幂等 / 原子失败：经 API 断言 + 直读库校验，避免依赖 UI 措辞。
 */
import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime } from './runtime';

const rt = readRuntime();
const H = { 'content-type': 'application/json', 'x-offerflow-capture-client': 'offerflow-promotion-e2e' };

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(rt.dbPath, { readonly: true });
  db.pragma('busy_timeout = 4000');
  try { return fn(db); } finally { db.close(); }
}

function counts(): { jobs: number; applications: number; feedbackEvents: number; promotions: number } {
  return withDb((db) => {
    const c = (t: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t}`).get() as { n: number }).n;
    return { jobs: c('jobs'), applications: c('applications'), feedbackEvents: c('feedback_events'), promotions: c('radar_promotions') };
  });
}

interface PlanBody { plan: Record<string, unknown> }
interface PromoteBody { promotion: Record<string, string | null>; plan: Record<string, unknown>; created: boolean }

async function post(base: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}

const preview = (cv: string, body: unknown) => post(rt.apiUrl, `/radar/candidate-versions/${cv}/promotions/preview`, body);
const promote = (cv: string, body: unknown) => post(rt.apiUrl, `/radar/candidate-versions/${cv}/promotions`, body);

async function openReviewPage(page: Page): Promise<void> {
  await page.goto(`${rt.webUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
}

async function openRelationAndGenerate(page: Page): Promise<void> {
  await page.locator(`[data-testid="relation-${rt.suspectedRelationId}"]`).click();
  await expect(page.getByTestId('candidate-compare')).toBeVisible();
  const rec = page.getByTestId('recommendation-panel-review');
  await rec.getByTestId('recommendation-generate').click();
  await expect(rec.getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });
}

const promoPanel = (page: Page) => page.getByTestId('promotion-panel-review');

test.describe('V8-6 晋升 · 浏览器 create 全链路', () => {
  test('seed 基线：正式对象四表为空（晋升是唯一写入路径）', async () => {
    expect(rt.baseline).toEqual({ jobs: 0, applications: 0, feedbackEvents: 0, promotions: 0 });
  });

  test('建议条目点击晋升 → 面板出现；预览零写入', async ({ page }) => {
    await openReviewPage(page);
    await openRelationAndGenerate(page);

    // 未点晋升前，面板不渲染（入口在建议条目上，不自动展开）。
    await expect(promoPanel(page)).toHaveCount(0);

    const before = counts();
    await page.getByTestId('recommendation-promote-1').click();
    await expect(promoPanel(page)).toBeVisible();

    // 仅打开面板不应产生任何请求写入。
    expect(counts()).toEqual(before);

    await promoPanel(page).getByTestId('promotion-preview').click();
    await expect(promoPanel(page).getByTestId('promotion-plan')).toBeVisible({ timeout: 10_000 });

    // 预览零写入：四表计数与预览前完全一致。
    expect(counts()).toEqual(before);
    // 默认 hr_replied + feedback 深度 → 三类对象都是新建。
    await expect(promoPanel(page).getByTestId('promotion-object-job')).toContainText('新建');
    await expect(promoPanel(page).getByTestId('promotion-object-application')).toContainText('新建');
    await expect(promoPanel(page).getByTestId('promotion-object-feedback')).toContainText('新建');
  });

  test('未预览时确认不可用（Human-in-the-loop：禁止一键自动晋升）', async ({ page }) => {
    await openReviewPage(page);
    await openRelationAndGenerate(page);
    await page.getByTestId('recommendation-promote-1').click();

    await expect(promoPanel(page).getByTestId('promotion-confirm')).toBeDisabled();
  });

  test('确认晋升 → Job/Application/FeedbackEvent/Promotion 各写一条并展示 ID', async ({ page }) => {
    await openReviewPage(page);
    await openRelationAndGenerate(page);
    await page.getByTestId('recommendation-promote-1').click();

    const before = counts();
    await promoPanel(page).getByTestId('promotion-preview').click();
    await expect(promoPanel(page).getByTestId('promotion-plan')).toBeVisible({ timeout: 10_000 });
    await promoPanel(page).getByTestId('promotion-confirm').click();
    await expect(promoPanel(page).getByTestId('promotion-result')).toBeVisible({ timeout: 10_000 });

    // 四类对象各 +1。
    const after = counts();
    expect(after.jobs).toBe(before.jobs + 1);
    expect(after.applications).toBe(before.applications + 1);
    expect(after.feedbackEvents).toBe(before.feedbackEvents + 1);
    expect(after.promotions).toBe(before.promotions + 1);

    // UI 展示的正式对象 ID 必须与库内该条晋升一致（不是任意占位文本）。
    const row = withDb((db) => db.prepare(
      'SELECT id, job_id, application_id, feedback_event_id FROM radar_promotions ORDER BY created_at DESC LIMIT 1',
    ).get() as { id: string; job_id: string; application_id: string; feedback_event_id: string });

    await expect(promoPanel(page).getByTestId('promotion-result-job')).toContainText(row.job_id);
    await expect(promoPanel(page).getByTestId('promotion-result-application')).toContainText(row.application_id);
    await expect(promoPanel(page).getByTestId('promotion-result-feedback')).toContainText(row.feedback_event_id);
    await expect(promoPanel(page).getByTestId('promotion-result-id')).toContainText(row.id);
  });

  test('刷新后重新预览：显示已晋升过，且不会再建一份', async ({ page }) => {
    // 承接上一用例已晋升的候选：刷新页面重走一遍预览。
    await openReviewPage(page);
    await openRelationAndGenerate(page);
    await page.getByTestId('recommendation-promote-1').click();

    const before = counts();
    await promoPanel(page).getByTestId('promotion-preview').click();
    await expect(promoPanel(page).getByTestId('promotion-plan')).toBeVisible({ timeout: 10_000 });

    await expect(promoPanel(page).getByTestId('promotion-clamp-already_promoted')).toContainText('不会再建一份');
    // 预览仍然零写入。
    expect(counts()).toEqual(before);
  });
});

test.describe('V8-6 晋升 · 真实 API', () => {
  test('link 模式：显式指认既有 Job 时关联而非新建第二份', async () => {
    // 先用一个候选以 job_only 建出一个真实 Job（user_priority 只允许到 job_only）。
    const seedCv = rt.apiCandidateVersionIds[0]!;
    const seeded = await promote(seedCv, { trigger: 'user_priority', requestedDepth: 'job_only' });
    expect(seeded.status).toBe(201);
    const jobId = (seeded.json as PromoteBody).promotion.jobId!;

    // 另一个候选显式指认该 Job：预览应为 link，且给出目标 id。
    const linkCv = rt.apiCandidateVersionIds[1]!;
    const pv = await preview(linkCv, { trigger: 'hr_replied', requestedDepth: 'feedback', jobId });
    expect(pv.status).toBe(200);
    expect((pv.json as PlanBody).plan).toMatchObject({ jobMode: 'link', linkedJobId: jobId, applicationMode: 'create' });

    // 确认后 jobs 不增（关联既有），applications/events/promotions 各 +1。
    const before = counts();
    const done = await promote(linkCv, { trigger: 'hr_replied', requestedDepth: 'feedback', jobId });
    expect(done.status).toBe(201);
    expect((done.json as PromoteBody).promotion.jobId).toBe(jobId);

    const after = counts();
    expect(after.jobs).toBe(before.jobs);
    expect(after.applications).toBe(before.applications + 1);
    expect(after.feedbackEvents).toBe(before.feedbackEvents + 1);
    expect(after.promotions).toBe(before.promotions + 1);
  });

  test('深度钳制：user_priority 请求 feedback 实际只到 job_only', async () => {
    const cv = rt.apiCandidateVersionIds[2]!;
    const pv = await preview(cv, { trigger: 'user_priority', requestedDepth: 'feedback' });

    expect(pv.status).toBe(200);
    expect((pv.json as PlanBody).plan).toMatchObject({
      requestedDepth: 'feedback', effectiveDepth: 'job_only',
      applicationMode: 'none', feedbackMode: 'none', feedbackEventType: null,
    });
    expect((pv.json as PlanBody).plan.clampReasons).toContain('trigger_forbids_application');

    // 确认后只建 Job：applications / feedback_events 不增。
    const before = counts();
    const done = await promote(cv, { trigger: 'user_priority', requestedDepth: 'feedback' });
    expect(done.status).toBe(201);
    expect((done.json as PromoteBody).promotion.applicationId).toBeNull();
    expect((done.json as PromoteBody).promotion.feedbackEventId).toBeNull();

    const after = counts();
    expect(after.jobs).toBe(before.jobs + 1);
    expect(after.applications).toBe(before.applications);
    expect(after.feedbackEvents).toBe(before.feedbackEvents);
  });

  test('no_response 禁止晋升：预览与执行均 409 且零写入', async () => {
    const cv = rt.apiCandidateVersionIds[3]!;
    const before = counts();

    const pv = await preview(cv, { trigger: 'no_response', requestedDepth: 'feedback' });
    expect(pv.status).toBe(409);
    expect(pv.json.code).toBe('PROMOTION_TRIGGER_NOT_ALLOWED');

    const ex = await promote(cv, { trigger: 'no_response', requestedDepth: 'feedback' });
    expect(ex.status).toBe(409);
    expect(ex.json.code).toBe('PROMOTION_TRIGGER_NOT_ALLOWED');

    // 两次拒绝都不得留下任何痕迹。
    expect(counts()).toEqual(before);
  });

  test('幂等：重复确认复用同一晋升，零新增写入', async () => {
    const cv = rt.apiCandidateVersionIds[3]!;
    const body = { trigger: 'hr_replied', requestedDepth: 'feedback' };

    const first = await promote(cv, body);
    expect(first.status).toBe(201);
    expect((first.json as PromoteBody).created).toBe(true);

    const afterFirst = counts();
    const again = await promote(cv, body);
    // 幂等重放返回 200（未新建资源），只有首次创建才是 201——见 promotionRoutes 的 `created ? 201 : 200`。
    expect(again.status).toBe(200);
    expect((again.json as PromoteBody).created).toBe(false);
    // 复用同一条晋升与同一批正式对象。
    expect((again.json as PromoteBody).promotion).toEqual((first.json as PromoteBody).promotion);
    expect(counts()).toEqual(afterFirst);

    // 幂等命中后再预览：标注 already_promoted。
    const pv = await preview(cv, body);
    expect((pv.json as PlanBody).plan.clampReasons).toContain('already_promoted');
    expect((pv.json as PlanBody).plan.existingPromotionId).toBe((first.json as PromoteBody).promotion.id);
  });

  test('原子失败零残留：Promotion 撞主键时已写的 Job/Application/事件整体回滚', async () => {
    const cv = rt.apiCandidateVersionIds[4]!;
    const body = { trigger: 'hr_replied', requestedDepth: 'feedback' };

    // 第一次：第 4 次 createId 返回固定 id，Promotion 成功落库并占用该主键。
    const first = await post(rt.atomicApiUrl, `/radar/candidate-versions/${cv}/promotions`, body);
    expect(first.status).toBe(201);

    // 第二次换一个候选（不同幂等键，必须真正走写入路径），第 8 次 createId 又是同一固定 id → 撞主键。
    const before = counts();
    const victim = rt.apiCandidateVersionIds[0]!;
    const failed = await post(rt.atomicApiUrl, `/radar/candidate-versions/${victim}/promotions`, {
      trigger: 'interview_scheduled', requestedDepth: 'feedback',
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);

    // 关键断言：失败后四表与失败前完全一致——不留孤儿 Job/Application/事件。
    expect(counts()).toEqual(before);
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

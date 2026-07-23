import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime } from './runtime';

const rt = readRuntime();
const H = { 'x-offerflow-capture-client': 'offerflow-review-e2e' };

/** 只读打开临时 v8 库做断言（journal=DELETE，加 busy_timeout 兜底与服务端写连接并发）。 */
function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(rt.dbPath, { readonly: true });
  db.pragma('busy_timeout = 4000');
  try { return fn(db); } finally { db.close(); }
}

async function openReview(page: Page): Promise<void> {
  await page.goto(`${rt.webOnUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
  await expect(page.getByTestId('relation-list')).toBeVisible();
}

/** 直接命中评审 API（经前端代理，带 capture-client 头，走服务端安全网关）。 */
async function api(request: APIRequestContext, method: 'get' | 'post', url: string, data?: object) {
  return request[method](`${rt.webOnUrl}${url}`, { headers: H, ...(data ? { data } : {}) });
}

test.describe('V8-3 评审工作台 · 门禁与可达性', () => {
  test('flag 关闭时 /radar/review 不可访问（重定向且无工作台）', async ({ page }) => {
    await page.goto(`${rt.webOffUrl}/#/radar/review`);
    await expect.poll(() => page.url()).toContain('radar-review-disabled');
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toHaveCount(0);
  });

  test('schema v7 库评审 API 返回 404（采集桥不受影响）', async ({ request }) => {
    const review = await request.get(`${rt.apiV7Url}/radar/review/relations`, { headers: H });
    expect(review.status()).toBe(404);
    const capture = await request.post(`${rt.apiV7Url}/radar/capture-sessions`, { headers: H, data: {} });
    expect(capture.status()).not.toBe(404); // 命中路由（422 校验），证明采集桥仍注册
  });

  test('schema v8 sandbox 评审页可访问并列出待处理关系', async ({ page }) => {
    await openReview(page);
    await expect(page.getByTestId('decision-feed')).toBeVisible();
  });
});

test.describe('V8-3 评审工作台 · 决策 feed 结构化原因', () => {
  test('material / regression / ambiguous / identity conflict 均带结构化原因', async ({ page }) => {
    await openReview(page);
    await expect(page.getByTestId('feed-material_change')).toHaveCount(1);
    await expect(page.getByTestId('feed-extraction_regression')).toHaveCount(1);
    await expect(page.getByTestId('feed-ambiguous_change')).toHaveCount(1);
    await expect(page.getByTestId('feed-identity_conflict')).toHaveCount(1);
    // identity_conflict 无候选、带冲突原因，且其 open 按钮禁用。
    await expect(page.getByTestId('feed-conflict-reason').first()).toBeVisible();
  });
});

test.describe('V8-3 评审工作台 · 规则证据三态与覆盖', () => {
  test('structured / legacy_scalar / corrupt 三态呈现', async ({ page }) => {
    await openReview(page);
    // 通过 material_change feed 项打开候选（feed 项 open 按钮 testid 含 snapshotId，取该类首个）。
    const openBtn = page.locator('[data-testid="feed-material_change"] [data-testid^="feed-open-"]').first();
    await openBtn.click();
    await expect(page.getByTestId('candidate-compare')).toBeVisible();
    await expect(page.getByTestId('evidence-structured').first()).toBeVisible();
    await expect(page.getByTestId('evidence-legacy_scalar').first()).toBeVisible();
    await expect(page.getByTestId('evidence-corrupt').first()).toBeVisible();
  });

  test('override set 与 revert：原 RuleAssessment 不删除、追加审计动作', async ({ page }) => {
    const { uncoveredAssessmentId } = rt.fixture;
    const before = withDb((db) => ({
      row: db.prepare('SELECT result, evidence_json FROM radar_rule_assessments WHERE id = ?').get(uncoveredAssessmentId),
      total: (db.prepare('SELECT COUNT(*) c FROM radar_rule_assessments').get() as { c: number }).c,
      overrideActions: (db.prepare("SELECT COUNT(*) c FROM radar_actions WHERE action_type LIKE 'rule_override_%'").get() as { c: number }).c,
    }));

    await openReview(page);
    await page.locator('[data-testid="feed-material_change"] [data-testid^="feed-open-"]').first().click();
    await expect(page.getByTestId('candidate-compare')).toBeVisible();

    await page.getByTestId(`override-set-${uncoveredAssessmentId}`).click();
    await page.getByTestId('reason-input').locator('textarea').fill('该学历要求可接受');
    await page.getByTestId('confirm-submit').click();
    await expect(page.getByTestId('review-notice')).toBeVisible();

    // 重新打开候选，覆盖后应出现撤销按钮。
    await page.locator('[data-testid="feed-material_change"] [data-testid^="feed-open-"]').first().click();
    await page.getByTestId(`override-revert-${uncoveredAssessmentId}`).click();
    await page.getByTestId('reason-input').locator('textarea').fill('恢复规则默认判定');
    await page.getByTestId('confirm-submit').click();
    await expect(page.getByTestId('review-notice')).toBeVisible();

    const after = withDb((db) => ({
      row: db.prepare('SELECT result, evidence_json FROM radar_rule_assessments WHERE id = ?').get(uncoveredAssessmentId),
      total: (db.prepare('SELECT COUNT(*) c FROM radar_rule_assessments').get() as { c: number }).c,
      overrideActions: (db.prepare("SELECT COUNT(*) c FROM radar_actions WHERE action_type LIKE 'rule_override_%'").get() as { c: number }).c,
    }));
    expect(after.row).toEqual(before.row); // 原始评估行未被修改
    expect(after.total).toBe(before.total); // 未删除任何评估
    expect(after.overrideActions).toBe(before.overrideActions + 2); // set + revert 两条追加审计
  });
});

// 这是一次“有状态的人工评审验收旅程”，在同一 sandbox 中依次验证：
//   A 确认不同 + 刷新保持 → B confirm_same 提示/409 冲突/候选不删 → C 累积不变量。
// 用例 C 断言的是 A、B 执行后的累积状态（候选未因任一裁决被物理删除），
// 因此串行是产品流程语义要求，不是偶然的测试实现依赖；不得仅靠 workers:1 暗中维持。
// 用 describe.serial 显式固定：将来新增文件或调整并发配置也不会让该顺序悄悄失效。
test.describe.serial('V8-3 评审工作台 · 关系裁决（有状态验收旅程，显式串行）', () => {
  // 用例 A：suspected 关系并排对比 + 确认不同（必填原因）+ 移出默认列表 + 刷新保持。
  test('A 疑似重复对比、确认不同填写原因、移出默认列表并刷新保持', async ({ page }) => {
    const { suspectedRelationId } = rt.fixture;
    await openReview(page);
    await page.getByTestId(`relation-${suspectedRelationId}`).click();
    await expect(page.getByTestId('candidate-compare')).toBeVisible();
    // 并排对比两侧公司均可见。
    await expect(page.getByText('同城科技', { exact: false }).first()).toBeVisible();

    await page.getByTestId('btn-confirm-distinct').click();
    await expect(page.getByTestId('confirm-modal')).toBeVisible();
    // 原因为空时提交按钮禁用。
    await expect(page.getByTestId('confirm-submit')).toBeDisabled();
    await page.getByTestId('reason-input').locator('textarea').fill('两家为不同法人主体');
    await page.getByTestId('confirm-submit').click();
    await expect(page.getByTestId('review-notice')).toBeVisible();

    // confirmed_distinct 后移出默认待处理列表。
    await expect(page.getByTestId(`relation-${suspectedRelationId}`)).toHaveCount(0);
    // 刷新后状态保持（仍不在默认列表）。
    await page.reload();
    await expect(page.getByTestId('relation-list')).toBeVisible();
    await expect(page.getByTestId(`relation-${suspectedRelationId}`)).toHaveCount(0);
  });

  // 用例 B：recheck 关系 —— confirm_same 不物理合并提示 + 409 冲突保留原因 + 候选不删除。
  test('B confirmed_same 提示不物理合并、状态冲突返回 409 并保留原因、候选不删除', async ({ page, request }) => {
    const { recheckRelationId } = rt.fixture;
    const detail = withDb((db) => db.prepare(
      'SELECT candidate_id_low AS low, candidate_id_high AS high FROM radar_candidate_relations WHERE id = ?',
    ).get(recheckRelationId) as { low: string; high: string });

    await openReview(page);
    await page.getByTestId(`relation-${recheckRelationId}`).click();
    await expect(page.getByTestId('candidate-compare')).toBeVisible();

    // confirmed_same 明确提示不会物理合并。
    await expect(page.getByTestId('merge-note')).toContainText('不会立即删除、合并或迁移历史数据');
    await page.getByTestId('btn-confirm-same').click();
    await expect(page.getByTestId('confirm-modal')).toContainText('不物理合并');
    // 打开的是 confirm-distinct 之外的场景，先取消，改走 409 冲突路径。
    await page.getByRole('button', { name: '取消' }).click();

    // 打开 confirm-distinct 弹窗（此时期望状态锁定为 needs_recheck），提交前用 API 抢先改状态。
    await page.getByTestId('btn-confirm-distinct').click();
    await page.getByTestId('reason-input').locator('textarea').fill('这条原因必须在 409 后保留');
    const intervene = await api(request, 'post', '/radar/review/relations/confirm-same', {
      relationId: recheckRelationId, reason: '外部抢先确认相同', expectedCurrentStatus: 'needs_recheck',
    });
    expect(intervene.status()).toBe(200);
    // 现在 UI 提交（旧期望 needs_recheck）应 409，stale 提示出现且原因保留。
    await page.getByTestId('confirm-submit').click();
    await expect(page.getByTestId('stale-hint')).toBeVisible();
    await expect(page.getByTestId('reason-input').locator('textarea')).toHaveValue('这条原因必须在 409 后保留');

    // confirmed_same 后两个候选均未被物理删除。
    for (const id of [detail.low, detail.high]) {
      const res = await api(request, 'get', `/radar/review/candidates/${encodeURIComponent(id)}`);
      expect(res.status()).toBe(200);
    }
    const relStatus = withDb((db) => (db.prepare(
      'SELECT status FROM radar_candidate_relations WHERE id = ?',
    ).get(recheckRelationId) as { status: string }).status);
    expect(relStatus).toBe('confirmed_same');
  });

  // 用例 C：全流程后 Job / Application / FeedbackEvent 零新增，Candidate 数不因裁决减少。
  test('C 零新增 Job/Application/FeedbackEvent 且候选数不减少', async () => {
    const now = withDb((db) => ({
      jobs: (db.prepare('SELECT COUNT(*) c FROM jobs').get() as { c: number }).c,
      applications: (db.prepare('SELECT COUNT(*) c FROM applications').get() as { c: number }).c,
      feedbackEvents: (db.prepare('SELECT COUNT(*) c FROM feedback_events').get() as { c: number }).c,
      candidates: (db.prepare('SELECT COUNT(*) c FROM radar_candidates').get() as { c: number }).c,
    }));
    expect(now.jobs).toBe(rt.baseline.jobs);
    expect(now.applications).toBe(rt.baseline.applications);
    expect(now.feedbackEvents).toBe(rt.baseline.feedbackEvents);
    expect(now.candidates).toBe(rt.baseline.candidates); // confirmed_same 不物理合并 → 候选不减少
  });
});

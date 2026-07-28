/**
 * RC-10 雷达动作 E2E。
 *
 * 分工：
 * - **浏览器**覆盖动作栏交互：四族一键切换、刷新后状态恢复、撤销后恢复、
 *   忽略后旧推荐立即清空 + 重新生成时被排除 + 撤销后恢复资格、收藏/优先不误排除；
 * - **真实 API + 直读库**覆盖不便经 UI 断言的不变量：动作历史 append-only、幂等、
 *   no_response(applied_pending) 不产生拒绝/能力反证、已晋升候选正式事实逐字节不变、库完整性。
 *
 * 库为串行共享：scope 敏感的忽略/待反馈用例结束后自行撤销，避免污染后续用例的推荐 scope。
 */
import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime, formalSignature, integrityOk, foreignKeyViolations } from './runtime';

const rt = readRuntime();
const H = { 'content-type': 'application/json', 'x-offerflow-capture-client': 'offerflow-action-e2e' };

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(rt.dbPath, { readonly: true });
  db.pragma('busy_timeout = 4000');
  try { return fn(db); } finally { db.close(); }
}

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${rt.apiUrl}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${rt.apiUrl}${path}`, { headers: H });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const apply = (body: unknown) => post('/radar/actions/apply', body);
const revert = (body: unknown) => post('/radar/actions/revert', body);
const viewOf = (candidateId: string) => get(`/radar/actions/candidates/${encodeURIComponent(candidateId)}`);

async function openReviewPage(page: Page): Promise<void> {
  await page.goto(`${rt.webUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
}
async function openSuspected(page: Page): Promise<void> {
  await page.locator(`[data-testid="relation-${rt.suspectedRelationId}"]`).click();
  await expect(page.getByTestId('candidate-compare')).toBeVisible();
}
const recPanel = (page: Page) => page.getByTestId('recommendation-panel-review');
const lowBar = (page: Page) => page.getByTestId('action-bar-low');

test.describe('RC-10 动作栏 · 浏览器交互', () => {
  test('每侧候选卡各挂一个动作栏，四族初始均为未生效（可置位）', async ({ page }) => {
    await openReviewPage(page);
    await openSuspected(page);
    for (const side of ['low', 'high']) {
      const bar = page.getByTestId(`action-bar-${side}`);
      await expect(bar).toBeVisible();
      for (const f of ['save', 'ignore', 'priority', 'appliedPending']) {
        await expect(bar.getByTestId(`action-set-${f}`)).toBeVisible();
        await expect(bar.getByTestId(`action-active-${f}`)).toHaveCount(0);
      }
    }
  });

  test('收藏：置位显示生效态；刷新后仍生效；撤销后恢复未生效', async ({ page }) => {
    await openReviewPage(page);
    await openSuspected(page);
    await lowBar(page).getByTestId('action-set-save').click();
    await expect(lowBar(page).getByTestId('action-active-save')).toBeVisible();

    // 刷新（重新加载 + 重开关系）：状态由服务端事件流恢复，不依赖本地缓存。
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
    await openSuspected(page);
    await expect(lowBar(page).getByTestId('action-active-save')).toBeVisible();

    // 撤销：回到未生效，set 按钮重现。
    await lowBar(page).getByTestId('action-revert-save').click();
    await expect(lowBar(page).getByTestId('action-set-save')).toBeVisible();
    await expect(lowBar(page).getByTestId('action-active-save')).toHaveCount(0);
  });

  test('标记优先：置位 / 刷新恢复 / 撤销恢复', async ({ page }) => {
    await openReviewPage(page);
    await openSuspected(page);
    await lowBar(page).getByTestId('action-set-priority').click();
    await expect(lowBar(page).getByTestId('action-active-priority')).toBeVisible();
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
    await openSuspected(page);
    await expect(lowBar(page).getByTestId('action-active-priority')).toBeVisible();
    await lowBar(page).getByTestId('action-revert-priority').click();
    await expect(lowBar(page).getByTestId('action-set-priority')).toBeVisible();
  });

  test('忽略：旧推荐立即清空 → 重新生成排除该候选 → 撤销后恢复资格', async ({ page }) => {
    await openReviewPage(page);
    await openSuspected(page);

    // 先生成 2 条（低侧 apply_now + 高侧 stretch）。
    await recPanel(page).getByTestId('recommendation-generate').click();
    await expect(recPanel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });
    await expect(recPanel(page).getByTestId('recommendation-count')).toContainText('共 2 条');

    // 忽略低侧候选：动作变化让 invalidationKey 自增 → 旧推荐立即清空。
    await lowBar(page).getByTestId('action-set-ignore').click();
    await expect(lowBar(page).getByTestId('action-active-ignore')).toBeVisible();
    await expect(recPanel(page).getByTestId('recommendation-result')).toHaveCount(0);

    // 重新生成：低侧被排除（ignored_unchanged），只剩高侧 1 条。
    await recPanel(page).getByTestId('recommendation-generate').click();
    await expect(recPanel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });
    await expect(recPanel(page).getByTestId('recommendation-count')).toContainText('共 1 条');
    await expect(recPanel(page).getByTestId('recommendation-blocked-ignored_unchanged')).toHaveCount(1);

    // 撤销忽略：再次清空 → 重新生成恢复到 2 条（资格恢复）。
    await lowBar(page).getByTestId('action-revert-ignore').click();
    await expect(recPanel(page).getByTestId('recommendation-result')).toHaveCount(0);
    await recPanel(page).getByTestId('recommendation-generate').click();
    await expect(recPanel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });
    await expect(recPanel(page).getByTestId('recommendation-count')).toContainText('共 2 条');
    await expect(recPanel(page).getByTestId('recommendation-blocked-ignored_unchanged')).toHaveCount(0);
  });

  test('收藏 / 标记优先不排除候选：重新生成仍为 2 条', async ({ page }) => {
    await openReviewPage(page);
    await openSuspected(page);
    await lowBar(page).getByTestId('action-set-save').click();
    await expect(lowBar(page).getByTestId('action-active-save')).toBeVisible();

    await recPanel(page).getByTestId('recommendation-generate').click();
    await expect(recPanel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });
    // saved 不进入 blocked：低侧仍被推荐，共 2 条、无被排除项。
    await expect(recPanel(page).getByTestId('recommendation-count')).toContainText('共 2 条');
    await expect(recPanel(page).getByTestId('recommendation-blocked')).toHaveCount(0);

    // 复位收藏，避免残留状态干扰后续用例的历史断言。
    await lowBar(page).getByTestId('action-revert-save').click();
    await expect(lowBar(page).getByTestId('action-set-save')).toBeVisible();
  });
});

test.describe('RC-10 动作 · 真实 API + 直读库不变量', () => {
  test('历史 append-only：apply→revert 追加两条可追踪事件，旧事件被回填 reverted 而非改写', async () => {
    const candidateId = rt.apiCandidateIds[0]!;
    const applied = await apply({ candidateId, family: 'save', reason: '高匹配' });
    expect(applied.status).toBe(200);
    expect(applied.json.changed).toBe(true);

    const reverted = await revert({ candidateId, family: 'save' });
    expect(reverted.json.changed).toBe(true);

    const { json: view } = await viewOf(candidateId);
    // 升序（旧→新）两条：saved（已被撤销）→ unsaved。
    expect(view.history.map((h: any) => h.actionType)).toEqual(['saved', 'unsaved']);
    const saved = view.history.find((h: any) => h.actionType === 'saved');
    expect(saved).toMatchObject({ family: 'save', isSet: true, reason: '高匹配', reverted: true });
    expect(view.history.find((h: any) => h.actionType === 'unsaved')).toMatchObject({ isSet: false });
    // 撤销后生效态回到未收藏。
    expect(view.state.saved).toBe(false);
  });

  test('幂等：重复 apply 同一族 changed=false，不新增历史事件', async () => {
    const candidateId = rt.apiCandidateIds[1]!;
    const first = await apply({ candidateId, family: 'ignore' });
    expect(first.json.changed).toBe(true);
    const second = await apply({ candidateId, family: 'ignore' });
    expect(second.json.changed).toBe(false);

    const { json: view } = await viewOf(candidateId);
    expect(view.state.ignored).toBe(true);
    expect(view.history.filter((h: any) => h.actionType === 'ignored')).toHaveLength(1);

    // 复位，避免污染后续完整性用例的推荐 scope 语义。
    await revert({ candidateId, family: 'ignore' });
  });

  test('no_response（已投待反馈）不产生拒绝或能力反证：正式表零新增', async () => {
    const candidateId = rt.apiCandidateIds[2]!;
    const before = withDb((db) => ({
      applications: (db.prepare('SELECT COUNT(*) n FROM applications').get() as { n: number }).n,
      feedback: (db.prepare('SELECT COUNT(*) n FROM feedback_events').get() as { n: number }).n,
      evidence: (db.prepare('SELECT COUNT(*) n FROM candidate_evidence').get() as { n: number }).n,
    }));

    const res = await apply({ candidateId, family: 'appliedPending', channel: 'boss' });
    expect(res.status).toBe(200);
    expect(res.json.view.state.appliedPending).toBe(true);

    // 无回复语义：不建 Application、不落拒绝 FeedbackEvent、不生成负向 CandidateEvidence。
    const after = withDb((db) => ({
      applications: (db.prepare('SELECT COUNT(*) n FROM applications').get() as { n: number }).n,
      feedback: (db.prepare('SELECT COUNT(*) n FROM feedback_events').get() as { n: number }).n,
      evidence: (db.prepare('SELECT COUNT(*) n FROM candidate_evidence').get() as { n: number }).n,
    }));
    expect(after).toEqual(before);

    // 服务端补齐审计锚点：appliedAt 为数值、sourceSnapshotId 由服务端解析（非客户端提供）。
    const meta = withDb((db) => JSON.parse((db.prepare(
      `SELECT metadata_json m FROM radar_actions WHERE candidate_id = ? AND action_type = 'marked_applied_pending'`,
    ).get(candidateId) as { m: string }).m) as Record<string, unknown>);
    expect(typeof meta.appliedAt).toBe('number');
    expect(meta.channel).toBe('boss');

    await revert({ candidateId, family: 'appliedPending' });
  });

  test('已晋升候选：执行并撤销全部四族动作后，Job/Application/FeedbackEvent/Promotion 逐字节不变', async () => {
    const candidateId = rt.promotedCandidateId;
    const before = withDb((db) => formalSignature(db as unknown as import('./runtime').SqlLike));
    expect(before).toBe(rt.baseline.formalSig); // seed 后从未被动改。

    for (const family of ['save', 'ignore', 'priority', 'appliedPending'] as const) {
      const a = await apply({ candidateId, family });
      expect(a.status).toBe(200);
      const r = await revert({ candidateId, family });
      expect(r.status).toBe(200);
    }

    // 关键断言：动作只写 radar_actions，正式四表签名与晋升后基线完全一致。
    const after = withDb((db) => ({
      sig: formalSignature(db as unknown as import('./runtime').SqlLike),
      counts: {
        jobs: (db.prepare('SELECT COUNT(*) n FROM jobs').get() as { n: number }).n,
        applications: (db.prepare('SELECT COUNT(*) n FROM applications').get() as { n: number }).n,
        feedbackEvents: (db.prepare('SELECT COUNT(*) n FROM feedback_events').get() as { n: number }).n,
        promotions: (db.prepare('SELECT COUNT(*) n FROM radar_promotions').get() as { n: number }).n,
      },
    }));
    expect(after.sig).toBe(rt.baseline.formalSig);
    expect(after.counts).toEqual({
      jobs: rt.baseline.jobs, applications: rt.baseline.applications,
      feedbackEvents: rt.baseline.feedbackEvents, promotions: rt.baseline.promotions,
    });
  });

  test('库完整性：全部用例跑完后无损坏、无悬挂外键', async () => {
    withDb((db) => {
      expect(integrityOk(db as unknown as import('./runtime').PragmaLike)).toBe(true);
      expect(foreignKeyViolations(db as unknown as import('./runtime').PragmaLike)).toBe(0);
    });
  });
});

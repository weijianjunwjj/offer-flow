import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime, tableSignature, integrityOk, foreignKeyViolations } from './runtime';
import type { ProviderCounts } from './controllableProvider';

const rt = readRuntime();
const H = { 'x-offerflow-capture-client': 'offerflow-analysis-e2e' };

/** 只读打开临时 v8 库做断言（journal=DELETE，busy_timeout 兜底并发写连接）。 */
function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(rt.dbPath, { readonly: true });
  db.pragma('busy_timeout = 4000');
  try { return fn(db); } finally { db.close(); }
}
function rows(db: Database.Database, t: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
}
const compare = (page: Page) => page.getByTestId('candidate-compare');

async function openMaterialCandidate(page: Page): Promise<void> {
  await page.goto(`${rt.webUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
  const openBtn = page.locator('[data-testid="feed-material_change"] [data-testid^="feed-open-"]').first();
  await openBtn.click();
  await expect(page.getByTestId('candidate-compare')).toBeVisible();
}
async function counts(request: APIRequestContext): Promise<ProviderCounts> {
  const r = await request.get(`${rt.apiUrl}/e2e/analysis-counts`, { headers: H });
  expect(r.ok()).toBe(true);
  return r.json() as Promise<ProviderCounts>;
}

/** profiles active 版本推进为本场景的**预期变更**，与零污染分开断言。 */
function assertCoreUnpolluted(): void {
  withDb((db) => {
    expect(rows(db, 'jobs')).toBe(rt.baseline.jobs);
    expect(rows(db, 'applications')).toBe(rt.baseline.applications);
    expect(rows(db, 'feedback_events')).toBe(rt.baseline.feedbackEvents);
    expect(tableSignature(db, 'radar_candidate_versions')).toBe(rt.baseline.candidateVersionsSig);
    expect(tableSignature(db, 'radar_rule_assessments')).toBe(rt.baseline.ruleAssessmentsSig);
    expect(integrityOk(db)).toBe(true);
    expect(foreignKeyViolations(db)).toBe(0);
  });
}

test.describe('V8-4 单岗位分析 · 结果过期（场景 D：active JobMatchProfile 版本推进）', () => {
  test.beforeEach(async ({ request }) => {
    const r = await request.post(`${rt.apiUrl}/e2e/reset-analysis`, { headers: H, data: { mode: 'delayed_success' } });
    expect(r.ok()).toBe(true);
  });
  // 收尾：清空分析表 + 逐字节还原 profiles 原文（推进的 active 指针不留给后续/复用）。
  test.afterAll(async ({ request }) => {
    await request.post(`${rt.apiUrl}/e2e/reset-analysis`, { headers: H, data: { mode: 'delayed_success' } });
    await request.post(`${rt.apiUrl}/e2e/restore-profile`, { headers: H });
  });

  test('succeeded → 推进 active 画像版本 → 重开候选：旧分析 stale 历史参考，不新建任务/不调 Provider', async ({ page, request }) => {
    await openMaterialCandidate(page);

    // 1) 开始并完成一次分析（deterministic 闸门成功）。
    await compare(page).getByTestId('analysis-start').click();
    await expect(compare(page).getByTestId('analysis-running')).toBeVisible();
    const released = await request.post(`${rt.apiUrl}/e2e/release-analysis`, { headers: H });
    expect(released.ok()).toBe(true);
    await expect(compare(page).getByTestId('analysis-result')).toBeVisible();

    // 完成即当前有效（尚未 stale）。
    await expect(compare(page).getByTestId('analysis-validity')).toContainText('当前有效');
    await expect(compare(page).getByTestId('analysis-stale-banner')).toHaveCount(0);

    // 记录基线：taskId / analysisId / record 数 / generateCalls。
    const before = withDb((db) => ({
      taskId: (db.prepare('SELECT id FROM analysis_tasks').get() as { id: string }).id,
      analysisId: (db.prepare('SELECT id FROM job_match_analysis_records').get() as { id: string }).id,
      records: rows(db, 'job_match_analysis_records'),
      tasks: rows(db, 'analysis_tasks'),
    }));
    expect(before.records).toBe(1);
    expect(before.tasks).toBe(1);
    const genBefore = (await counts(request)).generateCalls;
    expect(genBefore).toBe(1);
    const frozenProfileVer = withDb((db) =>
      (db.prepare('SELECT job_match_profile_version_id v FROM job_match_analysis_records').get() as { v: string }).v);
    const frozenCandidateVer = withDb((db) =>
      (db.prepare('SELECT candidate_version_id v FROM job_match_analysis_records').get() as { v: string }).v);

    // 2) 通过控制端点推进 active JobMatchProfile 版本（真实领域状态变化，非前端 mock）。
    const advResp = await request.post(`${rt.apiUrl}/e2e/advance-profile-version`, { headers: H });
    expect(advResp.ok()).toBe(true);
    const adv = await advResp.json() as { oldVersionId: string; newVersionId: string; mutationType: string };
    expect(adv.mutationType).toBe('job_match_profile_version_advanced');
    expect(adv.oldVersionId).toBe(frozenProfileVer); // 旧 active 即记录冻结的画像版本。
    expect(adv.newVersionId).not.toBe(adv.oldVersionId);

    // 3) 后端真实 stale 前置：旧 record 冻结版本不变；当前 active 画像已变更。
    await expect.poll(async () => {
      const r = await request.get(`${rt.apiUrl}/radar/candidates/${rt.fixture.materialCandidateId}/analyses`, { headers: H });
      const list = await r.json() as Array<{ id: string; validity: { status: string; staleReasons: string[] } }>;
      return list[0]?.validity.status;
    }).toBe('stale');
    const listResp = await request.get(`${rt.apiUrl}/radar/candidates/${rt.fixture.materialCandidateId}/analyses`, { headers: H });
    const list = await listResp.json() as Array<{ id: string; candidateVersionId: string; jobMatchProfileVersionId: string; validity: { status: string; staleReasons: string[] } }>;
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(before.analysisId);
    expect(list[0]!.candidateVersionId).toBe(frozenCandidateVer); // 记录候选版本仍冻结原值。
    expect(list[0]!.jobMatchProfileVersionId).toBe(frozenProfileVer); // 记录画像版本仍冻结原值。
    expect(list[0]!.validity.staleReasons).toEqual(['job_match_profile_changed']); // 仅此一种真实原因。

    // 4) 重开候选（新面板挂载凭指针恢复 succeeded）→ 旧分析显 stale 历史参考。
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
    await openMaterialCandidate(page);
    await expect(compare(page).getByTestId('analysis-result')).toBeVisible();

    // stale banner 文案 + 中文原因映射 + 有效性标记「历史参考」。
    await expect(compare(page).getByTestId('analysis-stale-banner')).toContainText('该分析基于旧版本输入，仅供历史参考。');
    await expect(compare(page).getByTestId('analysis-stale-reasons')).toContainText('匹配画像已更新');
    await expect(compare(page).getByTestId('analysis-validity')).toContainText('历史参考');

    // 旧 recommendation / confidence / summary 仍可查看。
    await expect(compare(page).getByTestId('analysis-recommendation')).toHaveText('核验后再决定');
    await expect(compare(page).getByTestId('analysis-confidence')).toContainText('低');
    await expect(compare(page).locator('.summary-text')).toContainText('证据不足');

    // 5) 不自动建任务 / 不自动调 Provider：taskId、analysisId、record 数、generateCalls 全部不变。
    withDb((db) => {
      expect(rows(db, 'analysis_tasks')).toBe(before.tasks);
      expect(rows(db, 'job_match_analysis_records')).toBe(before.records);
      expect((db.prepare('SELECT id FROM analysis_tasks').get() as { id: string }).id).toBe(before.taskId);
      expect((db.prepare('SELECT id FROM job_match_analysis_records').get() as { id: string }).id).toBe(before.analysisId);
    });
    expect((await counts(request)).generateCalls).toBe(genBefore); // Provider 调用次数未增。

    // 18) 本路径下 candidateVersionId 未变，面板对同一版本展示 stale 历史（succeeded 相），
    //     不会另起「开始分析」；核心硬约束「测试不真正创建第二个任务」已由上面 tasks 计数=1 保证。
    withDb((db) => expect(rows(db, 'analysis_tasks')).toBe(1));

    // 零污染（active 画像指针推进为预期变更，单独报告）。
    assertCoreUnpolluted();
  });
});

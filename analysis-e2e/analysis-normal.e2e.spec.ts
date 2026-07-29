import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime, tableSignature } from './runtime';

const rt = readRuntime();
const H = { 'x-offerflow-capture-client': 'offerflow-analysis-e2e' };

/** 只读打开临时 v8 库做断言（journal=DELETE，加 busy_timeout 兜底并发写连接）。 */
function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(rt.dbPath, { readonly: true });
  db.pragma('busy_timeout = 4000');
  try { return fn(db); } finally { db.close(); }
}

/** 打开评审工作台并经 material_change feed 项打开 material 候选（渲染出单岗位分析面板）。 */
async function openMaterialCandidate(page: Page): Promise<void> {
  await page.goto(`${rt.webUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
  const openBtn = page.locator('[data-testid="feed-material_change"] [data-testid^="feed-open-"]').first();
  await openBtn.click();
  await expect(page.getByTestId('candidate-compare')).toBeVisible();
}

const compare = (page: Page) => page.getByTestId('candidate-compare');

test.describe('V8-4 单岗位分析 · 正常流程 + 刷新恢复（场景 A）', () => {
  test('开始分析 → running → 刷新恢复 running → 完成 succeeded → 结论/四维/证据/历史，且只有一个 task', async ({ page, request }) => {
    await openMaterialCandidate(page);

    // 面板初始为未开始，展示开始分析按钮。
    await expect(compare(page).getByTestId('analysis-not-started')).toBeVisible();
    const startBtn = compare(page).getByTestId('analysis-start');
    await expect(startBtn).toBeVisible();

    // 点击开始分析：闸门 Provider 让任务停在 running（不用固定 sleep，靠控制端点释放）。
    await startBtn.click();
    await expect(compare(page).getByTestId('analysis-running')).toBeVisible();

    // 刷新前确认后端确已建任务且处于非终态（进程内执行，浏览器刷新不影响服务端执行）。
    await expect.poll(() => withDb((db) =>
      (db.prepare("SELECT COUNT(*) c FROM analysis_tasks WHERE status IN ('queued','running')").get() as { c: number }).c,
    )).toBe(1);

    // 刷新页面：新面板挂载后凭 sessionStorage taskId 指针恢复 running（不重新 create）。
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
    // 刷新后 SPA 需重新打开候选（feed 选择态不持久）；面板凭指针恢复 running。
    await openMaterialCandidate(page);
    await expect(compare(page).getByTestId('analysis-running')).toBeVisible();
    // 未出现开始按钮 → 证明是恢复而非重新开始。
    await expect(compare(page).getByTestId('analysis-start')).toHaveCount(0);

    // 释放闸门：running 的 generate 立即返回合法 payload → 任务转 succeeded。
    const released = await request.post(`${rt.apiUrl}/e2e/release-analysis`, { headers: H });
    expect(released.ok()).toBe(true);

    // 面板轮询到 succeeded → 展示结论先行的结果。
    await expect(compare(page).getByTestId('analysis-result')).toBeVisible();
    await expect(compare(page).getByTestId('analysis-recommendation')).toHaveText('核验后再决定');
    await expect(compare(page).getByTestId('analysis-confidence')).toContainText('低');
    await expect(compare(page).getByTestId('analysis-validity')).toContainText('当前有效');
    // summary 文案可见。
    await expect(compare(page).locator('.summary-text')).toContainText('证据不足');

    // 四维分析俱全。
    for (const dim of ['roleFit', 'capabilityFit', 'businessAndCompanyFit', 'cityAndSalaryFit']) {
      await expect(compare(page).getByTestId(`analysis-dim-${dim}`)).toBeVisible();
    }

    // 证据引用可展开：jobFact 携带目录内真实 evidenceKey，展开 <details> 后 key 可见。
    const jobFacts = compare(page).getByTestId('analysis-jobfacts');
    await expect(jobFacts).toBeVisible();
    const evidence = jobFacts.locator('details.evidence').first();
    await expect(evidence).toBeVisible();
    await evidence.locator('summary').click();
    await expect(evidence.locator('code.ekey').first()).toBeVisible();

    // 历史列表出现本次分析（当前有效）。
    await expect.poll(() => withDb((db) =>
      (db.prepare('SELECT COUNT(*) c FROM job_match_analysis_records').get() as { c: number }).c,
    )).toBe(1);

    // 全程只创建了一个 task（幂等 + 恢复不重复 create）。
    const taskCount = withDb((db) =>
      (db.prepare('SELECT COUNT(*) c FROM analysis_tasks').get() as { c: number }).c);
    expect(taskCount).toBe(1);

    // 零污染：jobs/applications/feedback_events 计数与候选版本/规则评估签名均未变。
    withDb((db) => {
      const count = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
      expect(count('jobs')).toBe(rt.baseline.jobs);
      expect(count('applications')).toBe(rt.baseline.applications);
      expect(count('feedback_events')).toBe(rt.baseline.feedbackEvents);
      expect(tableSignature(db, 'radar_candidate_versions')).toBe(rt.baseline.candidateVersionsSig);
      expect(tableSignature(db, 'radar_rule_assessments')).toBe(rt.baseline.ruleAssessmentsSig);
    });
  });

  test('重开候选凭历史/指针直接展示已完成结果，不重复创建任务', async ({ page }) => {
    // 前一用例已完成分析并落 succeeded；重开候选应直接凭历史/指针展示结果，不再 create。
    await openMaterialCandidate(page);
    await expect(compare(page).getByTestId('analysis-result')).toBeVisible();
    await expect(compare(page).getByTestId('analysis-start')).toHaveCount(0);
    // 仍只有一个 task、一条分析记录。
    withDb((db) => {
      expect((db.prepare('SELECT COUNT(*) c FROM analysis_tasks').get() as { c: number }).c).toBe(1);
      expect((db.prepare('SELECT COUNT(*) c FROM job_match_analysis_records').get() as { c: number }).c).toBe(1);
    });
  });
});

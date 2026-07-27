import { test, expect, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime, tableSignature, integrityOk, foreignKeyViolations } from './runtime';

const rt = readRuntime();
const H = { 'x-offerflow-capture-client': 'offerflow-recommendation-e2e' };

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(rt.dbPath, { readonly: true });
  db.pragma('busy_timeout = 4000');
  try { return fn(db); } finally { db.close(); }
}

async function openReviewPage(page: Page): Promise<void> {
  await page.goto(`${rt.webUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
}

async function openRelation(page: Page, relationId: string): Promise<void> {
  await page.locator(`[data-testid="relation-${relationId}"]`).click();
  await expect(page.getByTestId('candidate-compare')).toBeVisible();
}

// review 页外层 data-testid 经 Vue 属性透传覆盖组件内 NCard 的 recommendation-panel。
const panel = (page: Page) => page.getByTestId('recommendation-panel-review');

test.describe('V8-5 岗位建议批次 E2E', () => {
  test('生成批次 + 展示 1–2 条（apply_now 优先于 stretch，按 priority 排序）', async ({ page }) => {
    await openReviewPage(page);
    await openRelation(page, rt.suspectedRelationId);

    // V8-4 分析面板不应渲染（analysis flag 关闭，推荐面板独立开启）。
    await expect(page.getByTestId('analysis-panel')).toHaveCount(0);

    await expect(panel(page)).toBeVisible();
    await panel(page).getByTestId('recommendation-generate').click();
    await expect(panel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });
    await expect(panel(page).getByTestId('recommendation-count')).toContainText('共 2 条');

    // 优先级 #1 = apply_now / 高置信度；#2 = stretch / 中置信度。
    const item1 = panel(page).getByTestId('recommendation-item-1');
    const item2 = panel(page).getByTestId('recommendation-item-2');
    await expect(item1.getByTestId('recommendation-kind')).toContainText('建议立即投递');
    await expect(item1.getByTestId('recommendation-confidence')).toContainText('高');
    await expect(item2.getByTestId('recommendation-kind')).toContainText('冲刺机会');
    await expect(item2.getByTestId('recommendation-confidence')).toContainText('中');
    await expect(item1.getByTestId('recommendation-rationale')).toBeVisible();
  });

  test('幂等：同一 scope 重复生成命中同一批次，DB 批次行数不增', async ({ page }) => {
    await openReviewPage(page);
    await openRelation(page, rt.suspectedRelationId);
    await panel(page).getByTestId('recommendation-generate').click();
    await expect(panel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });

    const meta1 = await panel(page).getByTestId('recommendation-meta').textContent();
    const batchIdMatch = /批次\s+(rece2e-batch-\d+)/.exec(meta1 ?? '');
    const batchId = batchIdMatch?.[1];

    // 生成第二次：幂等，同 scope + 同分析状态 → 复用同一批次。
    await panel(page).getByTestId('recommendation-generate').click();
    await expect(panel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 8_000 });
    const meta2 = await panel(page).getByTestId('recommendation-meta').textContent();
    expect(meta2).toContain(batchId ?? '');

    const batchCount = withDb((db) =>
      (db.prepare("SELECT COUNT(*) c FROM radar_recommendation_batches WHERE id = ?").get(batchId ?? '') as { c: number }).c);
    expect(batchCount).toBe(1);
  });

  test('Candidate 切换不串数据 + 0 条建议展示 emptyReason', async ({ page }) => {
    await openReviewPage(page);
    // 先开疑似关系得到结果。
    await openRelation(page, rt.suspectedRelationId);
    await panel(page).getByTestId('recommendation-generate').click();
    await expect(panel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });

    // 切换到 recheck 关系：面板应清空，不展示上一个 scope 的建议。
    await openRelation(page, rt.recheckRelationId);
    await expect(panel(page).getByTestId('recommendation-result')).toHaveCount(0);
    await expect(panel(page).getByTestId('recommendation-count')).toHaveCount(0);

    // recheck 关系两侧无 current 分析 → emptyReason = no_current_successful_analysis。
    await panel(page).getByTestId('recommendation-generate').click();
    await expect(panel(page).getByTestId('recommendation-empty')).toBeVisible({ timeout: 10_000 });
    await expect(panel(page).getByTestId('recommendation-empty-reason-code')).toContainText('no_current_successful_analysis');
  });

  test('刷新后加载最新批次：展示 1–8 条 + blocked candidates', async ({ page, request }) => {
    // 通过真实 POST API 创建 wide 批次（8 可推荐 + 2 硬约束命中 = 8 条建议 + 2 条 blocked）。
    const res = await request.post(`${rt.apiUrl}/radar/recommendation-batches`, {
      headers: H,
      data: { candidateVersionIds: rt.wideScope },
    });
    expect(res.ok()).toBe(true);
    const created = await res.json() as { selectedCandidateVersionIds: string[] };
    expect(created.selectedCandidateVersionIds).toHaveLength(8);

    // 先进入评审页再刷新（模拟用户刷新后回到工作台），重新打开候选后点击「加载最新批次」。
    await openReviewPage(page);
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
    await openRelation(page, rt.suspectedRelationId);
    await panel(page).getByTestId('recommendation-load-latest').click();
    await expect(panel(page).getByTestId('recommendation-result')).toBeVisible({ timeout: 10_000 });

    // 应展示 wide 批次（8 条，2 条 blocked）。
    await expect(panel(page).getByTestId('recommendation-count')).toContainText('共 8 条');
    await expect(panel(page).getByTestId('recommendation-item-8')).toBeVisible();
    await expect(panel(page).getByTestId('recommendation-blocked')).toContainText('被排除的候选（2）');
    // 两条硬约束命中候选各一行（同 reason testid），断言数量而非单一可见。
    await expect(panel(page).getByTestId('recommendation-blocked-hard_constraint_hit')).toHaveCount(2);
  });

  test('零写入：jobs/applications/feedback_events 与版本/评估/分析记录签名不变', async () => {
    withDb((db) => {
      const c = (t: string) => (db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c;
      expect(c('jobs')).toBe(rt.baseline.jobs);
      expect(c('applications')).toBe(rt.baseline.applications);
      expect(c('feedback_events')).toBe(rt.baseline.feedbackEvents);
      expect(tableSignature(db, 'radar_candidate_versions')).toBe(rt.baseline.candidateVersionsSig);
      expect(tableSignature(db, 'radar_rule_assessments')).toBe(rt.baseline.ruleAssessmentsSig);
      expect(tableSignature(db, 'job_match_analysis_records')).toBe(rt.baseline.analysisRecordsSig);
      expect(integrityOk(db as unknown as import('./runtime').PragmaLike)).toBe(true);
      expect(foreignKeyViolations(db as unknown as import('./runtime').PragmaLike)).toBe(0);
    });
  });
});

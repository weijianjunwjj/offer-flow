import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import Database from 'better-sqlite3';
import { readRuntime, tableSignature, integrityOk, foreignKeyViolations } from './runtime';
import { MALFORMED_MARKER, type ProviderMode, type ProviderCounts } from './controllableProvider';

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
/**
 * 泄漏检查只针对分析面板本身（不含 JD/识别字段等评审区文本），避免误报也更贴合诉求。
 * 面板 testid 由父级按侧注入为 analysis-panel-<side>（Vue attr fallthrough 覆盖组件内置值），
 * material_change 只开单候选（低侧），故用前缀匹配定位唯一分析面板。
 */
const panelText = (page: Page) => compare(page).locator('[data-testid^="analysis-panel-"]').innerText();

/** 经 material_change feed 项打开 material 候选（渲染单岗位分析面板）。 */
async function openMaterialCandidate(page: Page): Promise<void> {
  await page.goto(`${rt.webUrl}/#/radar/review`);
  await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
  const openBtn = page.locator('[data-testid="feed-material_change"] [data-testid^="feed-open-"]').first();
  await openBtn.click();
  await expect(page.getByTestId('candidate-compare')).toBeVisible();
}

/** 场景隔离：清空两张分析表并把 Provider 设为指定测试模式（复位计数与闸门）。 */
async function resetAnalysis(request: APIRequestContext, mode: ProviderMode): Promise<void> {
  const r = await request.post(`${rt.apiUrl}/e2e/reset-analysis`, { headers: H, data: { mode } });
  expect(r.ok()).toBe(true);
}
async function counts(request: APIRequestContext): Promise<ProviderCounts> {
  const r = await request.get(`${rt.apiUrl}/e2e/analysis-counts`, { headers: H });
  expect(r.ok()).toBe(true);
  return r.json() as Promise<ProviderCounts>;
}

/** 零污染 + 库自检：seed 基线计数/签名不变、integrity=ok、无悬挂外键。 */
function assertCleanBaseline(): void {
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

test.describe('V8-4 单岗位分析 · 修复/重试/取消可靠性（场景 B/C/D）', () => {
  // 每个用例前清空分析表并设定模式：与 normal 谱共用同一 material 候选，靠 reset 完全隔离。
  test.beforeEach(async ({ request }) => {
    await resetAnalysis(request, 'delayed_success');
    assertCleanBaseline();
  });
  // 收尾：清空分析表并回落默认模式，绝不给后续（含 normal 谱）留下终态任务。
  test.afterAll(async ({ request }) => {
    await resetAnalysis(request, 'delayed_success');
  });

  test('malformed → 一次 repair → succeeded；不泄漏内部修复细节，仅一条记录', async ({ page, request }) => {
    await resetAnalysis(request, 'malformed_then_repair_success');
    await openMaterialCandidate(page);

    // 开始分析：run 同步完成 generate(非法)→repair(合法)→succeeded，面板轮询到成功结果。
    await compare(page).getByTestId('analysis-start').click();
    await expect(compare(page).getByTestId('analysis-result')).toBeVisible();
    await expect(compare(page).getByTestId('analysis-recommendation')).toHaveText('核验后再决定');
    await expect(compare(page).getByTestId('analysis-confidence')).toContainText('低');
    await expect(compare(page).locator('.summary-text')).toContainText('证据不足');

    // 页面绝不暴露 malformed 原文 / JSON 解析错误正文 / Prompt / Provider 原始响应。
    const text = await panelText(page);
    expect(text).not.toContain(MALFORMED_MARKER);
    expect(text).not.toContain('ANALYSIS_JSON_INVALID');
    expect(text).not.toMatch(/JSON|parse|Unexpected token|SyntaxError/i);
    await expect(compare(page).getByTestId('analysis-error')).toHaveCount(0);
    await expect(compare(page).getByTestId('analysis-conflict')).toHaveCount(0);

    // 控制端点断言：generate 恰 1 次、repair 恰 1 次。
    const c = await counts(request);
    expect(c.generateCalls).toBe(1);
    expect(c.repairCalls).toBe(1);

    // 只有一条 AnalysisRecord、一个 task；零污染。
    withDb((db) => {
      expect(rows(db, 'job_match_analysis_records')).toBe(1);
      expect(rows(db, 'analysis_tasks')).toBe(1);
    });
    assertCleanBaseline();
  });

  test('failed → retry（同一 task，attempt 1→2）→ succeeded；刷新仍 succeeded', async ({ page, request }) => {
    await resetAnalysis(request, 'fail_once_then_success');
    await openMaterialCandidate(page);

    // 首次开始：generate 抛网络错误 → 任务 failed，展示安全错误码/文案。
    await compare(page).getByTestId('analysis-start').click();
    await expect(compare(page).getByTestId('analysis-failed')).toBeVisible();
    await expect(compare(page).getByTestId('analysis-error-code')).toContainText('PROVIDER_NETWORK_ERROR');
    // 失败正文只含安全文案：无 stack / 网络响应正文 / Provider 原文。
    const failText = await panelText(page);
    expect(failText).not.toMatch(/stack|at Object|node_modules|Error:|https?:\/\//i);
    expect(failText).not.toContain(MALFORMED_MARKER);

    // attemptCount=1；且只有一个 task、零分析记录。
    const taskId = withDb((db) => {
      const t = db.prepare("SELECT id, attempt_count a, max_attempts m FROM analysis_tasks").get() as { id: string; a: number; m: number };
      expect(t.a).toBe(1);
      expect(t.m).toBe(3);
      expect(rows(db, 'analysis_tasks')).toBe(1);
      expect(rows(db, 'job_match_analysis_records')).toBe(0);
      return t.id;
    });

    // 点击重试：真实 UI 行为为 retry(failed→queued) 后自动 run；第二次 generate 成功。
    await compare(page).getByTestId('analysis-retry').click();
    await expect(compare(page).getByTestId('analysis-result')).toBeVisible();

    // 仍是同一个 deterministic task（未创建第二个）；attemptCount=2、maxAttempts 不变；仅一条记录。
    withDb((db) => {
      expect(rows(db, 'analysis_tasks')).toBe(1);
      const t = db.prepare('SELECT id, status s, attempt_count a, max_attempts m FROM analysis_tasks').get() as { id: string; s: string; a: number; m: number };
      expect(t.id).toBe(taskId);
      expect(t.s).toBe('succeeded');
      expect(t.a).toBe(2);
      expect(t.m).toBe(3);
      expect(rows(db, 'job_match_analysis_records')).toBe(1);
    });

    // generate 共 2 次（失败 1 + 成功 1），repair 0 次（网络错误不进入 repair）。
    const c = await counts(request);
    expect(c.generateCalls).toBe(2);
    expect(c.repairCalls).toBe(0);

    // 刷新后凭指针恢复：仍展示 succeeded，且 task 表仍是同一个 deterministic task。
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
    await openMaterialCandidate(page);
    await expect(compare(page).getByTestId('analysis-result')).toBeVisible();
    withDb((db) => {
      expect(rows(db, 'analysis_tasks')).toBe(1);
      expect((db.prepare('SELECT id FROM analysis_tasks').get() as { id: string }).id).toBe(taskId);
    });
    assertCleanBaseline();
  });

  test('running → cancel → cancelled（刷新仍 cancelled）→ 迟到结果被丢弃，绝不写记录/翻成功', async ({ page, request }) => {
    await resetAnalysis(request, 'delayed_cancellable');
    await openMaterialCandidate(page);

    // 开始分析：闸门 Provider 让任务停在 running。
    await compare(page).getByTestId('analysis-start').click();
    await expect(compare(page).getByTestId('analysis-running')).toBeVisible();
    await expect.poll(() => withDb((db) =>
      (db.prepare("SELECT COUNT(*) c FROM analysis_tasks WHERE status='running'").get() as { c: number }).c,
    )).toBe(1);

    // 取消：面板停轮询后 CAS 落 cancelled 并 abort；展示已取消、不提供重试。
    await compare(page).getByTestId('analysis-cancel').click();
    await expect(compare(page).getByTestId('analysis-cancelled')).toBeVisible();
    await expect(compare(page).getByTestId('analysis-retry')).toHaveCount(0);
    await expect.poll(() => withDb((db) =>
      (db.prepare('SELECT status FROM analysis_tasks').get() as { status: string }).status,
    )).toBe('cancelled');

    // 刷新：凭指针恢复仍为 cancelled 终态（不重新 create、不再轮询）。
    await page.reload();
    await expect(page.getByText('岗位雷达 · 人工评审工作台')).toBeVisible();
    await openMaterialCandidate(page);
    await expect(compare(page).getByTestId('analysis-cancelled')).toBeVisible();
    await expect(compare(page).getByTestId('analysis-retry')).toHaveCount(0);

    // 释放闸门模拟迟到结果，并等后台 generate 真正 settle（同步栅栏，不用固定 sleep）。
    const released = await request.post(`${rt.apiUrl}/e2e/release-analysis`, { headers: H });
    expect(released.ok()).toBe(true);
    await expect.poll(async () => (await counts(request)).generateSettled).toBe(1);

    // 迟到结果被丢弃：task 仍 cancelled、resultRecordId 为 null、零分析记录、task 数仍 1。
    withDb((db) => {
      const t = db.prepare('SELECT status s, result_record_id r FROM analysis_tasks').get() as { s: string; r: string | null };
      expect(t.s).toBe('cancelled');
      expect(t.r).toBeNull();
      expect(rows(db, 'job_match_analysis_records')).toBe(0);
      expect(rows(db, 'analysis_tasks')).toBe(1);
    });
    // 页面绝不翻成功：短暂等待后仍无 result，保持 cancelled。
    await expect(compare(page).getByTestId('analysis-result')).toHaveCount(0);
    await expect(compare(page).getByTestId('analysis-cancelled')).toBeVisible();
    assertCleanBaseline();
  });
});

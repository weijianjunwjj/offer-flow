import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type {
  AnalysisTaskView, JobMatchAnalysisView, JobMatchAnalysisPayloadV1,
} from '../../api/radarAnalysisApi';
import RadarAnalysisPanel from './RadarAnalysisPanel.vue';

const mocks = vi.hoisted(() => ({
  createTask: vi.fn(),
  getTask: vi.fn(),
  runTask: vi.fn(),
  retryTask: vi.fn(),
  cancelTask: vi.fn(),
  listCandidateAnalyses: vi.fn(),
  getAnalysis: vi.fn(),
}));
vi.mock('../../api/radarAnalysisApi', async (importActual) => {
  const actual = await importActual<typeof import('../../api/radarAnalysisApi')>();
  return { ...actual, radarAnalysisApi: mocks };
});

function task(over: Partial<AnalysisTaskView> = {}): AnalysisTaskView {
  return {
    id: 'task-1', taskType: 'job_match_analysis', entityType: 'candidate_version', entityId: 'cv-1',
    status: 'queued', attemptCount: 0, maxAttempts: 3, startedAt: null, finishedAt: null, cancelledAt: null,
    errorCode: null, errorMessage: null, resultRecordId: null, createdAt: 1_800_000_000, updatedAt: 1_800_000_000,
    ...over,
  };
}

function payload(over: Partial<JobMatchAnalysisPayloadV1> = {}): JobMatchAnalysisPayloadV1 {
  const dim = { summary: '维度摘要', assessment: 'moderate' as const, points: [] };
  return {
    contractVersion: 1,
    jobFacts: [{ statement: '岗位事实A', kind: 'fact', evidenceKeys: ['candidate:cv-1:role'] }],
    dimensions: {
      roleFit: { summary: '岗位维度', assessment: 'strong', points: [
        { statement: '结论点X', kind: 'inference', evidenceKeys: ['resume:r1:exp'], explanation: '解释X', impact: 'positive', severity: 'medium', confidence: 'medium' },
      ] },
      capabilityFit: dim, businessAndCompanyFit: dim, cityAndSalaryFit: dim,
    },
    transferableEvidence: [{ statement: '可迁移A', kind: 'fact', evidenceKeys: ['resume:r1:skill'], explanation: '解释', impact: 'positive', severity: 'low', confidence: 'high' }],
    gaps: [], risks: [], counterEvidence: [], uncertainties: [],
    missingEvidence: ['缺失项1'], hardConstraints: [],
    recommendation: 'apply_now', confidence: 'high', summary: '总体建议：立即投递',
    recruiterQuestions: ['问题1'], communicationAngles: ['切入点1'],
    ...over,
  };
}

function analysis(over: Partial<JobMatchAnalysisView> = {}): JobMatchAnalysisView {
  return {
    id: 'rec-1', candidateId: 'cand-1', candidateVersionId: 'cv-1', resumeVersionId: 'r1',
    jobMatchProfileVersionId: 'p1', cityCode: 'suzhou', capabilityBaselineVersionId: null,
    marketPositionVersionId: null, strategyVersionId: null, ruleVersion: 'rule-v1', promptVersion: 'prompt-v1',
    analysisPolicyVersion: 'policy-v1', modelProvider: 'fake', modelName: 'fake-model', modelVersion: null,
    inputHash: 'hash-1', recommendation: 'apply_now', confidence: 'high', payload: payload(),
    createdAt: 1_800_000_100, supersedesAnalysisId: null,
    validity: { status: 'current', staleReasons: [] },
    ...over,
  };
}

function mountPanel(over: Record<string, unknown> = {}) {
  return mount(RadarAnalysisPanel, {
    props: { candidateId: 'cand-1', candidateVersionId: 'cv-1', enabled: true, pollIntervalMs: 5, ...over },
    global: { stubs: { teleport: true } },
  });
}

beforeEach(() => {
  mocks.listCandidateAnalyses.mockResolvedValue([]);
  // 刷新恢复指针存 sessionStorage：逐用例清空，避免跨用例串味。
  try { globalThis.sessionStorage?.clear(); } catch { /* ignore */ }
});
afterEach(() => vi.useRealTimers());

/** 微任务刷新（不触发 5ms 轮询定时器）。 */
const micro = () => vi.advanceTimersByTimeAsync(0);
/** 触发下一次已排定的轮询（间隔 5ms）。 */
const poll = () => vi.advanceTimersByTimeAsync(5);

describe('RadarAnalysisPanel 门禁 / 未开始', () => {
  it('disabled：仅提示，不请求、无分析按钮', async () => {
    const wrapper = mountPanel({ enabled: false });
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-disabled"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-start"]').exists()).toBe(false);
    expect(mocks.listCandidateAnalyses).not.toHaveBeenCalled();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it('not_started：无历史 → 展示开始分析按钮', async () => {
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-not-started"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-start"]').exists()).toBe(true);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });
});

describe('RadarAnalysisPanel create→run→轮询→succeeded', () => {
  beforeEach(() => vi.useFakeTimers());

  it('开始分析：create（一次）→ run → queued/running → succeeded 结果', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'succeeded' }));
    mocks.getTask
      .mockResolvedValueOnce(task({ status: 'running', attemptCount: 1, startedAt: 1_800_000_050 }))
      .mockResolvedValue(task({ status: 'succeeded', attemptCount: 1, resultRecordId: 'rec-1', finishedAt: 1_800_000_060 }));
    mocks.getAnalysis.mockResolvedValue(analysis());
    mocks.listCandidateAnalyses.mockResolvedValue([]);

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro(); // createTask → queued → fireRun → 首次 poll(running)

    expect(mocks.createTask).toHaveBeenCalledTimes(1);
    expect(mocks.runTask).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="analysis-running"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-attempts"]').text()).toContain('1/3');

    await poll(); // 第二次 poll → succeeded → 拉取结果
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-recommendation"]').text()).toBe('建议立即投递');
    expect(mocks.getAnalysis).toHaveBeenCalledWith('rec-1');
  });

  it('succeeded 后轮询停止（不再请求 getTask）', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'succeeded' }));
    mocks.getTask.mockResolvedValue(task({ status: 'succeeded', resultRecordId: 'rec-1' }));
    mocks.getAnalysis.mockResolvedValue(analysis());
    mocks.listCandidateAnalyses.mockResolvedValue([]);

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro();
    const callsAfterTerminal = mocks.getTask.mock.calls.length;
    await poll();
    await poll();
    expect(mocks.getTask.mock.calls.length).toBe(callsAfterTerminal);
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);
  });
});

describe('RadarAnalysisPanel failed / retry / 上限 / cancel', () => {
  beforeEach(() => vi.useFakeTimers());

  it('failed：展示安全 errorCode/message + 重试按钮', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'failed' }));
    mocks.getTask.mockResolvedValue(task({ status: 'failed', attemptCount: 1, errorCode: 'PROVIDER_TIMEOUT', errorMessage: '模型响应超时' }));

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro();

    expect(wrapper.find('[data-testid="analysis-failed"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-error-code"]').text()).toContain('PROVIDER_TIMEOUT');
    expect(wrapper.find('[data-testid="analysis-error-message"]').text()).toContain('模型响应超时');
    expect(wrapper.find('[data-testid="analysis-retry"]').exists()).toBe(true);
  });

  it('retry：失败 → retry(queued) → run → succeeded', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'failed' }));
    mocks.getTask
      .mockResolvedValueOnce(task({ status: 'failed', attemptCount: 1, errorCode: 'PROVIDER_TIMEOUT', errorMessage: 'x' }))
      .mockResolvedValue(task({ status: 'succeeded', attemptCount: 2, resultRecordId: 'rec-1' }));
    mocks.retryTask.mockResolvedValue(task({ status: 'queued', attemptCount: 1 }));
    mocks.getAnalysis.mockResolvedValue(analysis());

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro();
    await wrapper.find('[data-testid="analysis-retry"]').trigger('click');
    await micro();
    expect(mocks.retryTask).toHaveBeenCalledTimes(1);
    expect(mocks.runTask).toHaveBeenCalledTimes(2);
    await poll();
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);
  });

  it('达 maxAttempts：禁用 retry 并说明原因', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'failed' }));
    mocks.getTask.mockResolvedValue(task({ status: 'failed', attemptCount: 3, maxAttempts: 3, errorCode: 'PROVIDER_ERROR', errorMessage: 'x' }));

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro();
    expect(wrapper.find('[data-testid="analysis-exhausted"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-retry"]').exists()).toBe(false);
  });

  it('cancel：取消进行中任务 → cancelled 终态，无 retry / 无重新开始', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'cancelled' }));
    mocks.getTask.mockResolvedValue(task({ status: 'running', attemptCount: 1 }));
    mocks.cancelTask.mockResolvedValue(task({ status: 'cancelled', cancelledAt: 1_800_000_070 }));

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro();
    expect(wrapper.find('[data-testid="analysis-cancel"]').exists()).toBe(true);
    await wrapper.find('[data-testid="analysis-cancel"]').trigger('click');
    await micro();
    expect(mocks.cancelTask).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="analysis-cancelled"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-retry"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-start"]').exists()).toBe(false);
  });
});

describe('RadarAnalysisPanel stale / 历史 / 候选切换', () => {
  it('stale：历史结果为 stale → 顶部提示 + 中文原因，仍可查看', async () => {
    mocks.listCandidateAnalyses.mockResolvedValue([
      analysis({ validity: { status: 'stale', staleReasons: ['resume_version_changed', 'rule_version_changed'] } }),
    ]);
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-stale-banner"]').exists()).toBe(true);
    const reasons = wrapper.find('[data-testid="analysis-stale-reasons"]').text();
    expect(reasons).toContain('简历版本已更新');
    expect(reasons).toContain('规则版本已更新');
    expect(wrapper.find('[data-testid="analysis-validity"]').text()).toContain('历史参考');
    // stale 不自动重新运行，不出现开始按钮
    expect(wrapper.find('[data-testid="analysis-start"]').exists()).toBe(false);
  });

  it('history 恢复：当前版本已有 current 结果 → 直接展示，无开始按钮', async () => {
    mocks.listCandidateAnalyses.mockResolvedValue([analysis()]);
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-validity"]').text()).toContain('当前有效');
    expect(wrapper.find('[data-testid="analysis-start"]').exists()).toBe(false);
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it('候选版本切换：重载新候选历史，不显示旧候选结果', async () => {
    mocks.listCandidateAnalyses.mockResolvedValueOnce([analysis({ candidateVersionId: 'cv-1' })]);
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);

    mocks.listCandidateAnalyses.mockResolvedValue([]); // 新版本无历史
    await wrapper.setProps({ candidateVersionId: 'cv-2' });
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-not-started"]').exists()).toBe(true);
    expect(mocks.listCandidateAnalyses).toHaveBeenCalledTimes(2);
  });
});

describe('RadarAnalysisPanel 并发 / 迟到响应 / 卸载', () => {
  beforeEach(() => vi.useFakeTimers());

  it('迟到轮询响应不污染切换后的新候选', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'running' }));
    let resolveGet: (v: AnalysisTaskView) => void = () => {};
    mocks.getTask.mockReturnValueOnce(new Promise<AnalysisTaskView>((res) => { resolveGet = res; }));

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro(); // createTask→queued→fireRun→pollOnce(getTask 挂起)

    mocks.listCandidateAnalyses.mockResolvedValue([]);
    await wrapper.setProps({ candidateVersionId: 'cv-2' }); // gen++，作废迟到响应
    await micro();
    // 迟到 getTask 才返回旧候选 running 状态
    resolveGet(task({ status: 'running', entityId: 'cv-1', attemptCount: 9 }));
    await micro();

    expect(wrapper.find('[data-testid="analysis-not-started"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="analysis-running"]').exists()).toBe(false);
  });

  it('卸载后停止轮询，不再请求 getTask', async () => {
    mocks.createTask.mockResolvedValue(task({ status: 'queued' }));
    mocks.runTask.mockResolvedValue(task({ status: 'running' }));
    mocks.getTask.mockResolvedValue(task({ status: 'running', attemptCount: 1 }));

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro();
    const before = mocks.getTask.mock.calls.length;
    wrapper.unmount();
    await poll();
    await poll();
    expect(mocks.getTask.mock.calls.length).toBe(before);
  });

  it('重复点击开始只创建一次任务（create 期间禁用）', async () => {
    let resolveCreate: (v: AnalysisTaskView) => void = () => {};
    mocks.createTask.mockReturnValueOnce(new Promise<AnalysisTaskView>((res) => { resolveCreate = res; }));
    mocks.runTask.mockResolvedValue(task({ status: 'running' }));
    mocks.getTask.mockResolvedValue(task({ status: 'running', attemptCount: 1 }));

    const wrapper = mountPanel();
    await micro();
    const btn = wrapper.find('[data-testid="analysis-start"]');
    await btn.trigger('click'); // create 挂起，actionBusy=true
    await btn.trigger('click'); // 应被禁用/守卫拦截
    await micro();
    resolveCreate(task({ status: 'queued' }));
    await micro();
    expect(mocks.createTask).toHaveBeenCalledTimes(1);
  });
});

describe('RadarAnalysisPanel 刷新恢复（sessionStorage taskId 指针）', () => {
  const KEY = (cvId: string) => `offerflow.analysis.task.${cvId}`;

  it('create 成功后按含 candidateVersionId 的键落 taskId 指针（只存 id）', async () => {
    vi.useFakeTimers();
    mocks.createTask.mockResolvedValue(task({ id: 'task-42', status: 'queued', entityId: 'cv-1' }));
    mocks.runTask.mockResolvedValue(task({ status: 'running' }));
    mocks.getTask.mockResolvedValue(task({ status: 'running', attemptCount: 1 }));

    const wrapper = mountPanel();
    await micro();
    await wrapper.find('[data-testid="analysis-start"]').trigger('click');
    await micro();

    expect(sessionStorage.getItem(KEY('cv-1'))).toBe('task-42');
    // 指针仅是 taskId，绝不含 snapshot/payload/JD。
    expect(sessionStorage.getItem(KEY('cv-1'))).not.toContain('{');
  });

  it('挂载时凭指针 GET task 恢复 running 并接管轮询 → succeeded', async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(KEY('cv-1'), 'task-99');
    mocks.getTask
      .mockResolvedValueOnce(task({ id: 'task-99', status: 'running', attemptCount: 1, entityId: 'cv-1' })) // recover
      .mockResolvedValueOnce(task({ id: 'task-99', status: 'running', attemptCount: 1, entityId: 'cv-1' })) // 首次接管轮询
      .mockResolvedValue(task({ id: 'task-99', status: 'succeeded', attemptCount: 1, resultRecordId: 'rec-1', entityId: 'cv-1' }));
    mocks.getAnalysis.mockResolvedValue(analysis());

    const wrapper = mountPanel();
    await micro(); // recoverPersistedTask→running→接管轮询→首个 pollOnce 仍 running，下一次轮询排入 setTimeout
    expect(wrapper.find('[data-testid="analysis-running"]').exists()).toBe(true);
    expect(mocks.createTask).not.toHaveBeenCalled(); // 恢复绝不自动 create
    expect(mocks.runTask).not.toHaveBeenCalled();    // 也不再次 run

    await poll(); // 下一轮询 → succeeded → 拉结果
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);
  });

  it('挂载时凭指针恢复 succeeded 终态并展示结果（保留指针供再次刷新）', async () => {
    sessionStorage.setItem(KEY('cv-1'), 'task-ok');
    mocks.getTask.mockResolvedValue(task({ id: 'task-ok', status: 'succeeded', resultRecordId: 'rec-1', entityId: 'cv-1' }));
    mocks.getAnalysis.mockResolvedValue(analysis());

    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-result"]').exists()).toBe(true);
    expect(sessionStorage.getItem(KEY('cv-1'))).toBe('task-ok'); // 终态保留指针
  });

  it('指针 entityId 与当前版本不符 → 清除且不污染，落 not_started，不 create', async () => {
    sessionStorage.setItem(KEY('cv-1'), 'task-other');
    mocks.getTask.mockResolvedValue(task({ id: 'task-other', status: 'running', entityId: 'cv-OTHER' }));

    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-not-started"]').exists()).toBe(true);
    expect(sessionStorage.getItem(KEY('cv-1'))).toBeNull(); // 陈旧指针被清除
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it('指针失效（getTask 404/拒绝）→ 清除指针，回落 not_started，不 create', async () => {
    sessionStorage.setItem(KEY('cv-1'), 'task-gone');
    mocks.getTask.mockRejectedValue(new ApiError('任务不存在', 404, { code: 'TASK_NOT_FOUND' }));

    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-not-started"]').exists()).toBe(true);
    expect(sessionStorage.getItem(KEY('cv-1'))).toBeNull();
    expect(mocks.createTask).not.toHaveBeenCalled();
  });

  it('旧候选指针不恢复到新候选：切到无指针的 cv-2 显示 not_started', async () => {
    sessionStorage.setItem(KEY('cv-1'), 'task-1');
    mocks.getTask.mockResolvedValue(task({ id: 'task-1', status: 'running', entityId: 'cv-1' }));

    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-running"]').exists()).toBe(true);

    // 切到 cv-2（该键无指针）：不得读到 cv-1 的 task。
    await wrapper.setProps({ candidateVersionId: 'cv-2' });
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-running"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="analysis-not-started"]').exists()).toBe(true);
  });
});

describe('RadarAnalysisPanel 中文映射', () => {
  it('recommendation / confidence / AnalysisPoint kind / 维度 assessment 中文', async () => {
    mocks.listCandidateAnalyses.mockResolvedValue([analysis({
      recommendation: 'skip', confidence: 'low',
      payload: payload({
        recommendation: 'skip', confidence: 'low',
        dimensions: {
          roleFit: { summary: 's', assessment: 'weak', points: [
            { statement: 'p-fact', kind: 'fact', evidenceKeys: ['candidate:cv-1:x'], explanation: 'e', impact: 'positive', severity: 'low', confidence: 'low' },
            { statement: 'p-pref', kind: 'user_preference', evidenceKeys: ['profile:p1:pref'], explanation: 'e', impact: 'mixed', severity: 'none', confidence: 'low' },
          ] },
          capabilityFit: { summary: 's', assessment: 'unknown', points: [] },
          businessAndCompanyFit: { summary: 's', assessment: 'strong', points: [] },
          cityAndSalaryFit: { summary: 's', assessment: 'moderate', points: [] },
        },
      }),
    })]);
    const wrapper = mountPanel();
    await flushPromises();
    expect(wrapper.find('[data-testid="analysis-recommendation"]').text()).toBe('建议跳过');
    expect(wrapper.find('[data-testid="analysis-confidence"]').text()).toContain('低');
    expect(wrapper.find('[data-testid="analysis-kind-fact"]').text()).toBe('事实');
    expect(wrapper.find('[data-testid="analysis-kind-user_preference"]').text()).toBe('用户偏好');
    expect(wrapper.find('[data-testid="analysis-dim-roleFit"]').text()).toContain('弱匹配');
  });

  it('提供方错误只暴露安全 message（不含 stack / prompt / provider 原文）', async () => {
    mocks.listCandidateAnalyses.mockRejectedValue(new ApiError('分析历史暂不可用', 503, { code: 'PROVIDER_UNAVAILABLE' }));
    const wrapper = mountPanel();
    await flushPromises();
    const text = wrapper.find('[data-testid="analysis-error"]').text();
    expect(text).toContain('分析历史暂不可用');
    expect(text).not.toContain('stack');
  });
});

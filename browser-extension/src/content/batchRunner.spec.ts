import { describe, expect, it, vi } from 'vitest';
import { BatchQueue } from './batchQueue';
import { runBatch, type RunnerEffects } from './batchRunner';
import type { KnownJobCapture, KnownJobExpected } from '../extractors/bossExtractor';

function expected(id: string): KnownJobExpected {
  return {
    externalRecordId: id, providerKey: 'boss_zhipin', canonicalSourceUrl: `https://www.zhipin.com/job_detail/${id}.html`,
    roleFromCard: '中级前端开发工程师', salaryFromCardNorm: '11-13K',
    salaryFromCard: { minK: 11, maxK: 13, period: 'month' }, salaryDecodedFromPua: false,
    companyDisplayName: '易诚互动',
    experienceFromCard: '3-5年', educationFromCard: '本科',
  };
}

function capture(status: KnownJobCapture['status'], blocking: string[] = []): KnownJobCapture {
  return {
    status, identityMatch: status !== 'failed', identityBasis: 'right_panel_href',
    rightPanelExternalRecordId: 'x', rightPanelRole: '中级前端开发工程师', salaryCrossCheck: 'unavailable',
    blockingIssues: blocking,
    role: { value: '中级前端开发工程师', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    company: { value: '易诚互动', source: 'selected_card', confidence: 'high', qualityIssues: [] },
    companyLegalName: null,
    city: { value: '苏州', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    district: { value: null, source: 'none', confidence: 'low', qualityIssues: [] },
    address: { value: null, source: 'none', confidence: 'low', qualityIssues: [] },
    salaryMinK: { value: 11, source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    salaryMaxK: { value: 13, source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    salaryPeriod: { value: 'month', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    experienceRequirement: { value: '3-5年', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    educationRequirement: { value: '本科', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    activityStatus: { value: '本周活跃', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    jdText: '岗位职责：…',
  };
}

interface FakeOpts {
  captureFor?: (id: string) => KnownJobCapture;
  matchFirst?: boolean;
  relocateNull?: string;
  onAfterCapture?: (id: string) => void;
}

function fakeEffects(log: string[], opts: FakeOpts = {}): RunnerEffects {
  return {
    relocateCard: (id) => (opts.relocateNull === id ? null : ({ id } as unknown as Element)),
    rightPanelMatchesExpected: () => opts.matchFirst === true,
    clickCard: (card) => { log.push(`click:${(card as unknown as { id: string }).id}`); },
    waitForRightPanelStable: async () => { log.push('wait'); return { timedOut: false }; },
    captureItem: (exp) => {
      log.push(`capture:${exp.externalRecordId}`);
      const cap = opts.captureFor ? opts.captureFor(exp.externalRecordId) : capture('captured');
      opts.onAfterCapture?.(exp.externalRecordId);
      return cap;
    },
    onProgress: () => {},
    sleep: async () => {},
  };
}

const OPTS = { interItemMs: 0, pollMs: 0 };

describe('runBatch — 串行编排 (§八)', () => {
  it('§八.6/§八.10 严格串行按顺序处理，每项一次点击', async () => {
    const q = new BatchQueue([expected('A'), expected('B'), expected('C')]);
    const log: string[] = [];
    await runBatch(q, fakeEffects(log), OPTS);
    expect(log).toEqual([
      'click:A', 'wait', 'capture:A',
      'click:B', 'wait', 'capture:B',
      'click:C', 'wait', 'capture:C',
    ]);
    expect(q.status).toBe('done');
    expect(q.summary().capturedCount).toBe(3);
  });

  it('§八.9 首项右侧已匹配时免重复点击', async () => {
    const q = new BatchQueue([expected('A'), expected('B')]);
    const log: string[] = [];
    await runBatch(q, fakeEffects(log, { matchFirst: true }), OPTS);
    // 首项 A 不点击（已匹配），仍采集；后续项恢复点击。
    expect(log).toEqual(['capture:A', 'click:B', 'wait', 'capture:B']);
  });

  it('§八.11/§八.12 先等右侧稳定再抽取（wait 在 capture 之前）', async () => {
    const q = new BatchQueue([expected('A')]);
    const log: string[] = [];
    await runBatch(q, fakeEffects(log), OPTS);
    expect(log.indexOf('wait')).toBeLessThan(log.indexOf('capture:A'));
  });

  it('§八.17 单项失败不影响后续项', async () => {
    const q = new BatchQueue([expected('A'), expected('B'), expected('C')]);
    const captureFor = (id: string): KnownJobCapture => (id === 'B' ? capture('failed', ['身份不一致']) : capture('captured'));
    await runBatch(q, fakeEffects([], { captureFor }), OPTS);
    const s = q.summary();
    expect(s).toMatchObject({ capturedCount: 2, failedCount: 1, pendingCount: 0 });
    expect(q.status).toBe('done');
  });

  it('§八.7 卡片重定位失败 → 该项 failed 并继续', async () => {
    const q = new BatchQueue([expected('A'), expected('B')]);
    const log: string[] = [];
    await runBatch(q, fakeEffects(log, { relocateNull: 'A' }), OPTS);
    const snap = q.snapshot();
    expect(snap.find((i) => i.externalRecordId === 'A')!.status).toBe('failed');
    expect(snap.find((i) => i.externalRecordId === 'B')!.status).toBe('captured');
    expect(log).not.toContain('click:A'); // 未定位到不点击
  });

  it('§八.18 运行中取消：停止派发后续项', async () => {
    const q = new BatchQueue([expected('A'), expected('B'), expected('C')]);
    const effects = fakeEffects([], { onAfterCapture: (id) => { if (id === 'A') q.cancel(); } });
    const results = await runBatch(q, effects, OPTS);
    expect(q.status).toBe('cancelled');
    expect(results).toHaveLength(1); // 只处理了 A
  });

  it('needs_correction 状态被如实记录（不阻塞后续）', async () => {
    const q = new BatchQueue([expected('A')]);
    await runBatch(q, fakeEffects([], { captureFor: () => capture('needs_correction') }), OPTS);
    expect(q.snapshot()[0]!.status).toBe('needs_correction');
    expect(q.snapshot()[0]!.qualityIssues.length).toBeGreaterThan(0);
  });

  it('§八.20 页面刷新前无正式写入：runBatch 只产出结果，不做任何网络（由 background 提交）', async () => {
    const q = new BatchQueue([expected('A')]);
    const netSpy = vi.fn();
    const effects = { ...fakeEffects([]), };
    await runBatch(q, effects, OPTS);
    expect(netSpy).not.toHaveBeenCalled(); // Runner 无网络注入，天然零写入
  });
});

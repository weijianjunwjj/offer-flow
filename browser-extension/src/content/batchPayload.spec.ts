import { describe, expect, it } from 'vitest';
import { buildBatchSubmitItems, type BatchSubmitContext } from './batchPayload';
import type { BatchItemResult } from './batchRunner';
import type { KnownJobCapture } from '../extractors/bossExtractor';

function cap(over: Partial<KnownJobCapture>): KnownJobCapture {
  return {
    status: 'captured', identityMatch: true, identityBasis: 'right_panel_href',
    rightPanelExternalRecordId: 'x', rightPanelRole: '中级前端开发工程师', salaryCrossCheck: 'unavailable',
    blockingIssues: [],
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
    activityStatus: { value: '3日内活跃', source: 'boss_dom', confidence: 'high', qualityIssues: [] },
    jdText: '岗位职责：负责数据可视化开发。任职要求：本科。',
    ...over,
  };
}

const ctx = (r: BatchItemResult): BatchSubmitContext => ({
  providerKey: 'boss_zhipin',
  canonicalSourceUrl: `https://www.zhipin.com/job_detail/${r.externalRecordId}.html`,
  pageTitle: '求职|找工作|招聘信息-BOSS直聘',
});

describe('buildBatchSubmitItems (§八.21/§八.23)', () => {
  it('包含全部逻辑岗位并按 selectionOrder 排序；captured/failed 语义正确', () => {
    const results: BatchItemResult[] = [
      { externalRecordId: 'C', selectionOrder: 2, capture: cap({ status: 'captured' }) },
      { externalRecordId: 'A', selectionOrder: 0, capture: cap({ status: 'captured' }) },
      { externalRecordId: 'B', selectionOrder: 1, capture: cap({ status: 'failed', identityMatch: false, blockingIssues: ['身份不一致'], jdText: null }) },
    ];
    const items = buildBatchSubmitItems(results, ctx);
    expect(items.map((i) => i.externalRecordId)).toEqual(['A', 'B', 'C']);

    const a = items[0]!;
    expect(a.commitBlocked).toBe(false);
    expect(a.recognizedFields?.company).toBe('易诚互动');
    expect(a.recognizedFields?.role).toBe('中级前端开发工程师');
    expect(a.visibleText).toContain('数据可视化开发');
    const meta = a.extractionMetadata as { company?: { display?: string; legal?: string | null }; batchItemStatus?: string; identity?: { externalRecordId?: string } };
    expect(meta.company?.display).toBe('易诚互动');
    expect(meta.company?.legal).toBeNull();
    expect(meta.batchItemStatus).toBe('captured');
    expect(meta.identity?.externalRecordId).toBe('A');
    expect((a.extractionMetadata as { activityStatus?: string }).activityStatus).toBe('3日内活跃');
    expect(a.sourceUrl).toBe('https://www.zhipin.com/job_detail/A.html');

    // failed 项：commitBlocked、无 recognizedFields、visibleText 为诊断摘要（不含整页列表）。
    const b = items[1]!;
    expect(b.commitBlocked).toBe(true);
    expect(b.recognizedFields).toBeNull();
    expect(b.visibleText).toContain('未能确认右侧详情属于所选岗位');
    expect(b.visibleText.length).toBeGreaterThan(0);
    expect((b.extractionMetadata as { commitBlocked?: boolean }).commitBlocked).toBe(true);
  });

  it('needs_correction 不阻塞但保留状态', () => {
    const results: BatchItemResult[] = [
      { externalRecordId: 'A', selectionOrder: 0, capture: cap({ status: 'needs_correction', salaryCrossCheck: 'mismatched' }) },
    ];
    const [item] = buildBatchSubmitItems(results, ctx);
    expect(item!.commitBlocked).toBe(false);
    expect(item!.status).toBe('needs_correction');
    expect((item!.extractionMetadata as { batchItemStatus?: string }).batchItemStatus).toBe('needs_correction');
  });

  it('medium 招聘机构展示名进入预览字段，但保留来源与人工确认问题', () => {
    const results: BatchItemResult[] = [{
      externalRecordId: 'A',
      selectionOrder: 0,
      capture: cap({
        status: 'needs_correction',
        company: {
          value: '高策华途',
          source: 'boss_dom',
          confidence: 'medium',
          qualityIssues: ['公司名称来自招聘者所属机构展示，可能不是真实用人公司，请人工确认'],
        },
      }),
    }];
    const [item] = buildBatchSubmitItems(results, ctx);
    expect(item!.recognizedFields?.company).toBe('高策华途');
    const meta = item!.extractionMetadata as { fields?: { company?: { confidence?: string; qualityIssues?: string[] } } };
    expect(meta.fields?.company?.confidence).toBe('medium');
    expect(meta.fields?.company?.qualityIssues?.join('')).toContain('招聘者所属机构');
  });
});

import type { FieldProvenance, KnownJobStatus } from '../extractors/bossExtractor';
import type { ExtractedRecognizedFields } from '../extractors/types';
import { EMPTY_RECOGNIZED_FIELDS } from '../extractors/types';
import type { BatchItemResult } from './batchRunner';

/**
 * V8-2 批量提交项构建（纯函数，可测试）。把单项已知身份采集结果转为服务端 addItem 载荷。
 * - 预览必须包含用户最终选择的全部逻辑岗位（含 failed），失败项 commitBlocked=true 且用诊断摘要；
 * - captured/needs_correction 用右侧 JD 作 visibleText；
 * - company 用展示名（source=selected_card），display/legal 区别写入 extractionMetadata（不改 schema）。
 */

export interface BatchSubmitItem {
  selectionOrder: number;
  captureMethod: 'boss_current_page';
  sourceUrl: string;
  pageTitle: string | null;
  visibleText: string;
  providerKey: string;
  externalRecordId: string;
  recognizedFields: ExtractedRecognizedFields | null;
  extractionMetadata: Record<string, unknown>;
  status: KnownJobStatus;
  commitBlocked: boolean;
}

export interface BatchSubmitContext {
  providerKey: string;
  canonicalSourceUrl: string;
  pageTitle: string | null;
}

function take<T>(field: FieldProvenance<T>): T | null {
  return field.confidence === 'low' ? null : field.value;
}

function fieldMeta<T>(field: FieldProvenance<T>): Record<string, unknown> {
  return { value: field.value, source: field.source, confidence: field.confidence, qualityIssues: field.qualityIssues };
}

const FAILED_VISIBLE_TEXT = '【批量采集未确认岗位身份】未能确认右侧详情属于所选岗位，已跳过 JD 正文；请在浏览器中打开该岗位详情后重试，或在下方手动补全。';

export function buildBatchSubmitItem(result: BatchItemResult, ctx: BatchSubmitContext): BatchSubmitItem {
  const cap = result.capture;
  const commitBlocked = cap.status === 'failed' || !cap.identityMatch;

  const jd = cap.jdText;
  const visibleText = !commitBlocked && jd !== null && jd.trim().length > 0
    ? jd
    : (commitBlocked
      ? `${FAILED_VISIBLE_TEXT}${cap.blockingIssues.length > 0 ? ` 原因：${cap.blockingIssues.join('；')}` : ''}`
      : '【右侧 JD 未采集到正文】请在浏览器中打开该岗位详情后重试，或在下方手动补全。');

  const recognizedFields: ExtractedRecognizedFields | null = commitBlocked
    ? null
    : {
      ...EMPTY_RECOGNIZED_FIELDS,
      company: take(cap.company),
      role: take(cap.role),
      city: take(cap.city),
      salaryMinK: take(cap.salaryMinK),
      salaryMaxK: take(cap.salaryMaxK),
      salaryPeriod: take(cap.salaryPeriod),
      experienceRequirement: take(cap.experienceRequirement),
      educationRequirement: take(cap.educationRequirement),
    };

  const extractionMetadata: Record<string, unknown> = {
    kind: 'boss_batch_capture',
    batchItemStatus: cap.status,
    identity: {
      providerKey: ctx.providerKey,
      externalRecordId: result.externalRecordId,
      canonicalSourceUrl: ctx.canonicalSourceUrl,
    },
    identityMatch: cap.identityMatch,
    identityBasis: cap.identityBasis,
    rightPanelExternalRecordId: cap.rightPanelExternalRecordId,
    salaryCrossCheck: cap.salaryCrossCheck,
    commitBlocked,
    blockingIssues: cap.blockingIssues,
    company: { display: cap.company.value, legal: cap.companyLegalName },
    district: cap.district.value,
    address: cap.address.value,
    /** 招聘者状态只作为采集时快照，不进入 recognizedFields/normalized 岗位事实。 */
    activityStatus: cap.activityStatus.value,
    fields: {
      role: fieldMeta(cap.role),
      company: fieldMeta(cap.company),
      city: fieldMeta(cap.city),
      district: fieldMeta(cap.district),
      address: fieldMeta(cap.address),
      salaryMinK: fieldMeta(cap.salaryMinK),
      salaryMaxK: fieldMeta(cap.salaryMaxK),
      salaryPeriod: fieldMeta(cap.salaryPeriod),
      experienceRequirement: fieldMeta(cap.experienceRequirement),
      educationRequirement: fieldMeta(cap.educationRequirement),
      activityStatus: fieldMeta(cap.activityStatus),
    },
  };

  return {
    selectionOrder: result.selectionOrder,
    captureMethod: 'boss_current_page',
    sourceUrl: ctx.canonicalSourceUrl,
    pageTitle: ctx.pageTitle,
    visibleText,
    providerKey: ctx.providerKey,
    externalRecordId: result.externalRecordId,
    recognizedFields,
    extractionMetadata,
    status: cap.status,
    commitBlocked,
  };
}

/** 按 selectionOrder 升序构建全部提交项（包含 failed，供预览展示与阻塞）。 */
export function buildBatchSubmitItems(
  results: BatchItemResult[],
  contextFor: (result: BatchItemResult) => BatchSubmitContext,
): BatchSubmitItem[] {
  return [...results]
    .sort((a, b) => a.selectionOrder - b.selectionOrder)
    .map((result) => buildBatchSubmitItem(result, contextFor(result)));
}

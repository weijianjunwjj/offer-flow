import { extractBoss, type BossExtraction } from './bossExtractor';
import { extractGenericPage } from './genericExtractor';
import type { ExtractedPage, ExtractedRecognizedFields } from './types';
import { EMPTY_RECOGNIZED_FIELDS } from './types';

export type CaptureMethod = 'boss_current_page' | 'generic_visible_text';

export interface ExtractionResult {
  captureMethod: CaptureMethod;
  page: ExtractedPage;
  /**
   * 完整 rich extraction 旁注（district/详细地址/每字段 source/confidence/qualityIssues、
   * 稳定身份、阻塞问题）。只用于写入服务端 raw_snapshot_json 的 extractionMetadata，不进入结构化八字段。
   */
  metadata: Record<string, unknown> | null;
  /** 稳定岗位身份（§六）：随条目发送到服务端用于精确去重，不依赖 securityId/列表 query。 */
  providerKey: string | null;
  externalRecordId: string | null;
  /** 规范化来源 URL（job_detail 无 query）；存在时作为条目 sourceUrl 覆盖列表页 URL。 */
  canonicalSourceUrl: string | null;
  /** 为真时上层必须禁止该条目确认写入（§六，例如 list_panel 未取到稳定岗位 ID）。 */
  commitBlocked: boolean;
}

function fieldMeta<T>(field: { value: T | null; source: string; confidence: string; qualityIssues: string[] }): Record<string, unknown> {
  return { value: field.value, source: field.source, confidence: field.confidence, qualityIssues: field.qualityIssues };
}

function buildBossMetadata(boss: BossExtraction): Record<string, unknown> {
  return {
    kind: 'boss_extraction',
    layout: boss.layout,
    district: boss.district.value,
    address: boss.address.value,
    /** 采集时招聘者活跃状态：易变元数据，不进入 CandidateVersion normalized 字段。 */
    activityStatus: boss.activityStatus.value,
    identity: {
      providerKey: boss.providerKey,
      externalRecordId: boss.externalRecordId,
      canonicalSourceUrl: boss.canonicalSourceUrl,
    },
    blockingIssues: boss.blockingIssues,
    commitBlocked: boss.blockingIssues.length > 0,
    // §七 身份一致性诊断：右侧详情头部 vs 选中卡片逐项对照，供人工核验与调试。
    listPanelDiagnostics: boss.listPanelDiagnostics,
    fields: {
      role: fieldMeta(boss.role),
      company: fieldMeta(boss.company),
      city: fieldMeta(boss.city),
      district: fieldMeta(boss.district),
      address: fieldMeta(boss.address),
      salaryMinK: fieldMeta(boss.salaryMinK),
      salaryMaxK: fieldMeta(boss.salaryMaxK),
      salaryPeriod: fieldMeta(boss.salaryPeriod),
      experienceRequirement: fieldMeta(boss.experienceRequirement),
      educationRequirement: fieldMeta(boss.educationRequirement),
      activityStatus: fieldMeta(boss.activityStatus),
    },
  };
}

/**
 * §八 list_panel 的 visibleText 兜底：
 * - JD 定位成功 → 只用右侧 JD 正文；
 * - list_panel 定位失败（无 JD）→ 绝不回退整页岗位列表文本，改用明确标注的诊断摘要（非空，
 *   以便预览页展示阻塞原因；DTO 要求 visibleText 至少 1 字符）；
 * - 非 list_panel（如 job_detail 选择器未命中）→ 保持既有通用可见文本降级，不破坏回归。
 */
function resolveBossVisibleText(
  boss: { layout: string; blockingIssues: string[] },
  jd: string | null,
  doc: Document,
): string {
  if (jd !== null && jd.trim().length > 0) return jd;
  if (boss.layout === 'list_panel') {
    const reason = boss.blockingIssues.length > 0 ? boss.blockingIssues.join('；') : '未定位到右侧当前岗位详情面板';
    return `【未采集到岗位 JD 正文】${reason}。已跳过整页岗位列表文本；请在浏览器中打开目标岗位的详情后重试，或在下方手动补全。`;
  }
  return extractGenericPage(doc).visibleText;
}

function isBossUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'www.zhipin.com' || parsed.hostname.endsWith('.zhipin.com');
  } catch {
    return false;
  }
}

function pageTitle(doc: Document): string | null {
  return doc.querySelector('title')?.textContent?.trim() ?? null;
}

/**
 * 只把「非低置信」的字段写入发送载荷；低置信/未识别字段保持 null，交由用户在预览页确认，
 * 绝不把猜测值当作确定事实发送（§四、§六）。district/详细地址不进 8 字段载荷（不改后端 DTO），
 * 只在 extractBoss 内部与原始快照中保留，且绝不写入 city。
 */
function bossToRecognizedFields(boss: BossExtraction): ExtractedRecognizedFields | null {
  const take = <T>(field: { value: T | null; confidence: 'high' | 'medium' | 'low' }): T | null => (
    field.confidence === 'low' ? null : field.value
  );
  const fields: ExtractedRecognizedFields = {
    ...EMPTY_RECOGNIZED_FIELDS,
    company: take(boss.company),
    role: take(boss.role),
    city: take(boss.city),
    salaryMinK: take(boss.salaryMinK),
    salaryMaxK: take(boss.salaryMaxK),
    salaryPeriod: take(boss.salaryPeriod),
    experienceRequirement: take(boss.experienceRequirement),
    educationRequirement: take(boss.educationRequirement),
  };
  const hasAny = Object.values(fields).some((value) => value !== null);
  return hasAny ? fields : null;
}

/**
 * 根据当前标签页 URL 选择定向解析器或通用降级，纯函数、不发起网络请求。
 * - BOSS list_panel / job_detail 都走定向 extractBoss；list_panel 不因 URL 非 /job_detail 而退回 generic（§三）。
 * - BOSS 命中时 visibleText 优先取定向 JD 卡片清洗文本（剔除导航/推荐/页脚/样式/隐藏反爬节点，§七）；
 *   未找到 JD 卡片则退回通用清洗后的可见文本，但不把整页文本当作 JD 正文。
 * - 非 BOSS 或 BOSS 结构完全不可识别（无字段、无身份、无阻塞信息）时降级为通用可见文本（recognizedFields=null）。
 */
export function selectAndExtract(url: string, doc: Document): ExtractionResult {
  if (isBossUrl(url)) {
    const boss = extractBoss(url, doc);
    const recognizedFields = bossToRecognizedFields(boss);
    // list_panel 始终走 BOSS 路径（即使字段未识别，也要透出稳定身份/阻塞信息，§三）；
    // job_detail 维持既有契约：结构完全不可识别（无字段）时降级为通用可见文本（不破坏回归）。
    const isBossJobContext = recognizedFields !== null || boss.layout === 'list_panel';
    if (isBossJobContext) {
      const jd = boss.jdText;
      const visibleText = resolveBossVisibleText(boss, jd, doc);
      return {
        captureMethod: 'boss_current_page',
        page: { pageTitle: pageTitle(doc), visibleText, recognizedFields },
        metadata: buildBossMetadata(boss),
        providerKey: boss.providerKey,
        externalRecordId: boss.externalRecordId,
        canonicalSourceUrl: boss.canonicalSourceUrl,
        commitBlocked: boss.blockingIssues.length > 0,
      };
    }
  }
  return {
    captureMethod: 'generic_visible_text',
    page: extractGenericPage(doc),
    metadata: { kind: 'generic_fallback', note: '通用可见文本降级，未做结构化字段提取' },
    providerKey: null,
    externalRecordId: null,
    canonicalSourceUrl: null,
    commitBlocked: false,
  };
}

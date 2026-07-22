import { isCleanCityLabel, parseCityAddress } from './cityAddress';
import { parseBossTitle } from './bossTitle';
import { extractCleanText } from './domText';

/**
 * BOSS 直聘（zhipin.com）当前页定向提取。纯函数，只读传入的 Document 与 URL 字符串，
 * 不访问 cookie/storage，不执行页面脚本，不从整页 visibleText 模糊猜测结构化字段。
 *
 * 相对旧实现修复（V8-2 真实采集验收反馈）：
 * - role / company 分别来自各自的定向节点，并做交叉校验，杜绝「公司写成岗位名」串位；
 * - city 只保留城市，district 单独拆出，完整地址单独保留，杜绝「城市抓成整地址」；
 * - 每个核心字段带来源(source)、置信度(confidence)与质量问题(qualityIssues)；
 * - 确定性 fallback：定向 DOM → 受控 title/address 解析 → unknown，绝不用整页文本猜测；
 * - JD 只取职位描述卡片，排除导航/推荐/聊天/页脚噪声；
 * - 支持两种布局：独立 job_detail 详情页、列表页左列表+右详情面板（各用独立选择器组）。
 */

export type FieldSource =
  | 'boss_dom'
  | 'boss_business_info'
  | 'boss_company_intro'
  | 'page_title'
  | 'generic_text'
  | 'user_correction'
  | 'selected_card'
  | 'none';
export type FieldConfidence = 'high' | 'medium' | 'low';

export interface FieldProvenance<T> {
  value: T | null;
  source: FieldSource;
  confidence: FieldConfidence;
  qualityIssues: string[];
}

export type BossLayout = 'job_detail' | 'list_panel' | 'unknown';

export interface BossExtraction {
  layout: BossLayout;
  role: FieldProvenance<string>;
  company: FieldProvenance<string>;
  city: FieldProvenance<string>;
  district: FieldProvenance<string>;
  address: FieldProvenance<string>;
  salaryMinK: FieldProvenance<number>;
  salaryMaxK: FieldProvenance<number>;
  salaryPeriod: FieldProvenance<string>;
  experienceRequirement: FieldProvenance<string>;
  educationRequirement: FieldProvenance<string>;
  /** 招聘者在页面上展示的采集时活跃状态；仅进入 raw extraction metadata，不进入岗位结构化事实。 */
  activityStatus: FieldProvenance<string>;
  /** 定向 JD 卡片纯文本；未找到卡片时为 null（此时上层不得把整页文本当作 JD 正文）。 */
  jdText: string | null;
  /** 稳定岗位身份（§六）：从 job_detail 链接提取，用于去重，不依赖 securityId/列表 query。 */
  providerKey: string | null;
  externalRecordId: string | null;
  canonicalSourceUrl: string | null;
  /**
   * 阻塞性质量问题（§六）：非空时上层应禁止确认写入（例如 list_panel 未取到稳定岗位 ID，
   * 或选中卡片与右侧详情无法唯一绑定为同一岗位）。
   */
  blockingIssues: string[];
  /** list_panel 身份绑定诊断（§七）：写入 extractionMetadata 供核验，job_detail 布局为 null。 */
  listPanelDiagnostics: ListPanelDiagnostics | null;
}

export type SalaryCrossCheck = 'matched' | 'mismatched' | 'unavailable';

/**
 * §二 右侧详情定位失败时的只读审计诊断（脱敏）：不含完整 JD、Cookie、Token、招聘者信息。
 * 用于说明「为什么没定位到右侧当前岗位头部」，供人工核验和真实页调试。
 */
export interface ListPanelLocateDiagnostics {
  layoutType: BossLayout;
  /** 含 JD 语义标题的候选容器数量（未截断，仅计数）。 */
  jdContainerCandidateCount: number;
  /** 从 JD 锚点向上找到的、含头部标题的最小面板候选数量。 */
  panelCandidateCount: number;
  /** 命中的 JD 语义标题关键词（去重）。 */
  jdKeywordsFound: string[];
  /** 候选 JD/面板节点的脱敏 bounding rect（四舍五入整数，最多 6 条；无布局信息时为空）。 */
  candidateRects: Array<{ role: 'jd' | 'panel'; left: number; top: number; width: number; height: number }>;
  /** rightPanelHeader 为空的具体原因。 */
  rejectedReason: string;
  /** 恒为 false：定位右侧面板不再要求可解析完整薪资（§四）。 */
  salaryRequiredForAnchor: false;
  /** 是否存在含 JD 的右侧容器，但因缺少可识别头部标题而被拒绝。 */
  jdContainerWithoutHeader: boolean;
  /** 命中 JD 语义关键词的真实节点总数（探针扫描到的，未截断计数）。 */
  keywordElementCount: number;
  /** 定位失败结构探针（§四）：脱敏节点级证据，仅 list_panel 定位失败时附带，最多 10 条。 */
  probe: JdNodeProbe[];
}

/**
 * §四 JD 定位失败结构探针（脱敏、只读）：解释「命中 JD 关键词的节点为什么没被当作右侧 JD 正文」。
 * 绝不含完整 JD/HTML、Cookie、Token、securityId、招聘者姓名头像联系方式。
 */
export interface JdNodeProbe {
  tag: string;
  id: string | null;
  /** class，最多 160 字符。 */
  className: string;
  ariaRole: string | null;
  ariaLabel: string | null;
  /** 可见文本前 40 字符（脱敏用途，判断是否 JD）。 */
  textPrefix: string;
  innerTextLen: number;
  rect: DomLikeRect | null;
  display: string | null;
  visibility: string | null;
  opacity: string | null;
  inIframe: boolean;
  inShadowRoot: boolean;
  /** 是否被 isInExcludedRegion 排除。 */
  excluded: boolean;
  /** 实际命中的 excluded selector（逐个测试得到）。 */
  excludedSelector: string | null;
  /** 命中的最近 excluded 祖先脱敏信息。 */
  excludedAncestor: { tag: string; className: string; rect: DomLikeRect | null } | null;
  /** 向上最多 8 层祖先链，用于区分「共享双栏祖先」与「真的在左侧列表内」。 */
  ancestors: Array<{
    tag: string;
    className: string;
    rect: DomLikeRect | null;
    /** 该祖先是否同时包含左侧岗位卡片（≥2 张或列表容器）。 */
    containsLeftCards: boolean;
    /** 该祖先文本是否含 JD 关键词。 */
    containsJdKeyword: boolean;
    /** 是否被视为 body/main/html 全页容器。 */
    bodyLevel: boolean;
  }>;
}

/** §六/§七 身份一致性诊断：右侧详情头部 vs 选中卡片的逐项对照与最终绑定判定。 */
export interface ListPanelDiagnostics {
  rightPanelRole: string | null;
  rightPanelSalary: string | null;
  selectedCardRole: string | null;
  selectedCardSalary: string | null;
  selectedCardCompany: string | null;
  /** 是否检测到明确的 selected / active 状态卡片。 */
  selectedStateDetected: boolean;
  /** 选中/绑定卡片 role 是否与右侧详情头部 role 完整相等。 */
  roleMatch: boolean;
  /** 薪资交叉校验结果：两侧都可读且相等=matched；相等失败=mismatched；任一侧不可读=unavailable。 */
  salaryCrossCheck: SalaryCrossCheck;
  identityMatch: boolean;
  identitySource: 'selected_card' | 'unique_exact_match' | 'none';
  externalRecordId: string | null;
  /** 定位失败审计（§二）：仅在未定位到右侧头部时非空。 */
  locate: ListPanelLocateDiagnostics | null;
}

interface LayoutSelectors {
  role: string[];
  company: string[];
  /** 「工商信息」模块容器：内部按结构关系读取「公司名称」标签对应值。 */
  businessInfo: string[];
  /** 「公司介绍」正文容器：从正文开头解析可确定的完整企业名称。 */
  companyIntro: string[];
  cityTag: string[];
  address: string[];
  salary: string[];
  tags: string[];
  jd: string[];
}

const JOB_DETAIL_SELECTORS: LayoutSelectors = {
  role: ['.job-banner .name h1', '.job-primary .name h1', '.job-primary .name', '.job-banner h1.name', 'h1.name', '.job-name'],
  company: ['.job-banner .company-info .name', '.sider-company .company-info .name', '.company-info a.name', '.company-info .name', 'a[ka="job-detail-company_custompage"]', '.company-name'],
  businessInfo: ['.job-detail-company .business-info', '.company-business', '.business-info', '.job-detail-company .level-list', '.company-info-list'],
  companyIntro: ['.job-sec.company-info .job-sec-text', '.job-detail-company .job-sec-text', '.company-info .fold-text', '.company-info .desc', '.job-detail-company .desc'],
  cityTag: ['.job-banner .info-primary .text-city', '.job-primary .text-city', '.text-city'],
  address: ['.job-location .location-address', '.location-address', '.job-address', '.job-detail-company .company-address'],
  salary: ['.job-banner .salary', '.job-primary .salary', '.salary'],
  tags: ['.job-banner .info-primary p', '.job-primary .info-primary p', '.tag-list li', '.job-tags span', '.job-keyword-list li'],
  jd: ['.job-detail-section .job-sec-text', '.job-sec .text', '.job-detail .detail-content .text', '.job-sec-text'],
};

/**
 * 容器内相对选择器（不带 .job-detail-box 前缀）：结构化定位到右侧详情容器后，
 * 在该容器「内部」查询字段用这套；否则带前缀的选择器在容器内无法命中自身。
 */
const LIST_PANEL_CONTAINER_SELECTORS: LayoutSelectors = {
  role: ['.job-name', '.name h1', 'h1.name', '.job-title', '.position-name'],
  company: ['.company-info .name', '.company-name', '.company-info a', 'a[href*="/gongsi/"]', '.company'],
  businessInfo: ['.business-info', '.company-business', '.level-list', '.company-info-list'],
  companyIntro: ['.job-sec.company-info .job-sec-text', '.company-info .job-sec-text', '.company-info .desc', '.company-info .fold-text'],
  cityTag: ['.text-city', '.job-area .text-city', '.job-address'],
  address: ['.location-address', '.job-address'],
  salary: ['.salary', '.red', '.job-salary'],
  tags: ['.tag-list li', '.job-tags span', '.info-primary p', '.tags li', '.job-tags li'],
  jd: ['.job-sec-text', '.job-detail .text', '.desc', '.job-sec .text', '.job-detail-text'],
};

function textOf(el: Element | null): string | null {
  if (el === null) return null;
  const text = el.textContent?.trim() ?? '';
  return text.length > 0 ? text : null;
}

function firstText(root: ParentNode, selectors: string[]): string | null {
  for (const selector of selectors) {
    const value = textOf(root.querySelector(selector));
    if (value !== null) return value;
  }
  return null;
}

function allTexts(root: ParentNode, selectors: string[]): string[] {
  const texts: string[] = [];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((el) => {
      const value = textOf(el);
      if (value !== null) texts.push(value);
    });
  }
  return texts;
}

function known<T>(value: T, source: FieldSource, confidence: FieldConfidence, qualityIssues: string[] = []): FieldProvenance<T> {
  return { value, source, confidence, qualityIssues };
}

function unknownField<T>(issue: string): FieldProvenance<T> {
  return { value: null, source: 'none', confidence: 'low', qualityIssues: [issue] };
}

function looksLikeJobTitle(text: string): boolean {
  return /(工程师|开发|前端|后端|全栈|测试|运维|产品|设计|经理|主管|专员|总监|架构师|实习|助理|顾问|销售|运营|项目)/.test(text);
}

/**
 * 完整企业名称识别：一段以合法企业后缀结尾的名称（含「苏州工业园区」等合法名称组成部分，
 * 不得剥离）。前缀为惰性匹配，故对「苏州工业园区航星信息技术服务有限公司」会完整捕获到
 * 第一个企业后缀处，保留全称。
 */
const COMPANY_FULL_NAME =
  /([一-龥A-Za-z0-9（）()·&]{2,60}?(?:有限责任公司|股份有限公司|集团有限公司|科技有限公司|信息技术服务有限公司|有限公司|集团公司|集团|研究院|研究所|事务所|中心))/;

/** 明显截断的公司文本（顶部卡片常被 BOSS 用省略号截断），不得作为最终可信公司名。 */
function isTruncatedCompany(name: string): boolean {
  return /\.{2,}/.test(name) || /…/.test(name) || /[·]{2,}$/.test(name) || /[一-龥]\s*\.$/.test(name);
}

/** 只有园区/地区/地址片段、没有企业主体后缀的文本，不能当公司名。 */
function looksLikePlaceOnly(name: string): boolean {
  if (/公司|集团|研究院|研究所|事务所|中心|工作室|银行|大学|学校|医院/.test(name)) return false;
  return /(园区|开发区|高新区|科技园|产业园|大厦|大楼|广场|路|街道?|号|栋|座|区$|市$)/.test(name);
}

/**
 * 判断一个候选公司文本是否可作为可信公司名：非截断、非岗位名、非工作地址、非纯地址片段。
 * 不要求一定含企业后缀（如「赞同科技」这类官方简称也可接受），但截断/地址片段一律拒绝。
 */
function isAcceptableCompany(name: string, roleValue: string | null, addressValue: string | null): boolean {
  const value = name.trim();
  if (value.length < 2) return false;
  if (isTruncatedCompany(value)) return false;
  if (roleValue !== null && value === roleValue) return false;
  if (looksLikeJobTitle(value)) return false;
  if (addressValue !== null && value === addressValue) return false;
  if (looksLikePlaceOnly(value)) return false;
  return true;
}

/**
 * 猎头岗位常只展示「招聘机构 · 招聘角色」，并不等同于已确认的真实用人公司。
 * 仅剥离最后一个分隔符后的受控角色词；不读取相邻 `.name`（招聘者姓名），不做自由文本猜测。
 */
const RECRUITER_AFFILIATION_ROLE = /^(?:猎头顾问|招聘顾问|招聘专员|招聘者|猎头|HR|人事)$/i;

function safeCompanyDisplayCandidate(name: string, roleValue: string | null, addressValue: string | null): boolean {
  const value = name.trim();
  if (value.length < 2 || value.length > 80) return false;
  if (roleValue !== null && value === roleValue) return false;
  if (looksLikeJobTitle(value)) return false;
  if (addressValue !== null && value === addressValue) return false;
  if (looksLikePlaceOnly(value)) return false;
  return true;
}

function recruiterAffiliationDisplay(raw: string): string | null {
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const separator = Math.max(normalized.lastIndexOf('·'), normalized.lastIndexOf('・'), normalized.lastIndexOf('|'), normalized.lastIndexOf('｜'));
  if (separator <= 0) return null;
  const company = normalized.slice(0, separator).trim();
  const role = normalized.slice(separator + 1).trim();
  return RECRUITER_AFFILIATION_ROLE.test(role) && company.length >= 2 ? company : null;
}

function extractRecruiterAffiliationCompany(
  root: ParentNode,
  roleValue: string | null,
  addressValue: string | null,
): FieldProvenance<string> | null {
  for (const node of Array.from(root.querySelectorAll('.job-boss-info .boss-info-attr'))) {
    const raw = textOf(node);
    if (raw === null) continue;
    const company = recruiterAffiliationDisplay(raw);
    if (company === null || !safeCompanyDisplayCandidate(company, roleValue, addressValue)) continue;
    const issues = ['公司名称来自招聘者所属机构展示，可能不是真实用人公司，请人工确认'];
    if (isTruncatedCompany(company)) issues.push('公司展示名被 BOSS 截断，请人工补全');
    return known(company, 'boss_dom', 'medium', issues);
  }
  return null;
}

function truncatedSelectedCompany(
  name: string | null,
  roleValue: string | null,
  addressValue: string | null,
): FieldProvenance<string> | null {
  if (name === null || !isTruncatedCompany(name) || !safeCompanyDisplayCandidate(name, roleValue, addressValue)) return null;
  return known(name.trim(), 'selected_card', 'medium', ['公司展示名被 BOSS 截断，请人工补全']);
}

function directTextEquals(el: Element, expected: string): boolean {
  return (el.textContent?.trim() ?? '') === expected;
}

/**
 * 「工商信息」模块中按结构关系读取「公司名称」标签对应的值（§二）：
 * 先在工商信息容器内定位文本恰为「公司名称」的标签节点，读其相邻值节点或同一行剩余文本；
 * 不做全文模糊搜索。容器缺失时在整个 document 内做同样的结构化定位作为兜底。
 */
function readLabeledCompanyName(root: ParentNode): string | null {
  const candidates = root.querySelectorAll('span, td, th, dt, dd, div, p, li, label');
  for (const node of Array.from(candidates)) {
    // 情况一：节点文本恰为标签「公司名称」→ 读相邻值。
    if (directTextEquals(node, '公司名称')) {
      const siblingValue = textOf(node.nextElementSibling);
      if (siblingValue !== null && siblingValue !== '公司名称') return siblingValue;
      const parent = node.parentElement;
      if (parent !== null) {
        const valueNode = textOf(parent.querySelector('.value, dd, td'));
        if (valueNode !== null && valueNode !== '公司名称') return valueNode;
        const parentText = parent.textContent?.trim() ?? '';
        if (parentText.startsWith('公司名称')) {
          const rest = parentText.slice('公司名称'.length).replace(/^[:：\s]+/, '').trim();
          if (rest.length > 0) return rest;
        }
      }
    }
    // 情况二：同一节点内联「公司名称：<值>」。
    const inline = (node.textContent?.trim() ?? '').match(/^公司名称[:：]\s*(\S.*)$/);
    if (inline !== null) {
      const value = inline[1]?.trim() ?? '';
      if (value.length > 0) return value;
    }
  }
  return null;
}

function extractBusinessInfoCompany(root: ParentNode, sel: LayoutSelectors): string | null {
  for (const selector of sel.businessInfo) {
    const containers = root.querySelectorAll(selector);
    for (const container of Array.from(containers)) {
      const value = readLabeledCompanyName(container);
      if (value !== null) return value;
    }
  }
  // 兜底：容器 class 与预期不符时，在给定范围内做结构化「公司名称」标签定位（仍非全文模糊搜索）。
  return readLabeledCompanyName(root);
}

/** 「公司介绍」正文开头解析可确定的完整企业名称（§二.2）。 */
function extractCompanyIntroName(root: ParentNode, sel: LayoutSelectors): string | null {
  for (const text of allTexts(root, sel.companyIntro)) {
    const match = text.match(COMPANY_FULL_NAME);
    if (match !== null) {
      const value = match[1]?.trim() ?? '';
      if (value.length > 0) return value;
    }
  }
  return null;
}

function detectLayout(url: string, doc: Document): BossLayout {
  // URL 优先：列表页与详情页路径互斥且最可靠。
  if (/\/web\/geek\/job/.test(url)) return 'list_panel';
  if (/\/job_detail\//.test(url)) return 'job_detail';
  // 其次看 DOM：列表页右侧详情面板容器更具体，优先于详情页 banner 判定
  // （列表页面板内也可能含 .job-sec-text，故先判 .job-detail-box）。
  if (doc.querySelector('.job-detail-box, .job-list-container, .job-list-wrapper') !== null) return 'list_panel';
  if (doc.querySelector('.job-banner, .job-detail-section, .job-sec-text') !== null) return 'job_detail';
  return 'unknown';
}

export function parseSalary(raw: string | null): { minK: number | null; maxK: number | null; period: string | null } {
  if (raw === null) return { minK: null, maxK: null, period: null };
  const match = raw.match(/(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*[Kk千]/);
  if (match === null) return { minK: null, maxK: null, period: null };
  const period = /(\d+)\s*薪/.test(raw) ? raw.match(/\d+\s*薪/)?.[0]?.replace(/\s+/g, '') ?? 'month' : 'month';
  return { minK: Number(match[1]), maxK: Number(match[2]), period };
}

/**
 * 合法薪资单位（§二）：薪资候选必须显式带单位，绝不能仅凭「数字-数字」判定。
 * 覆盖 K/k、千、万、元、面议。「3-5年」这类带「年」的经验区间被显式排除。
 */
const SALARY_WITH_UNIT_PATTERN = /(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*(?:[Kk千]|万\/?月?|元\/?月?)/;
const SALARY_NEGOTIABLE_PATTERN = /面议/;

/** 一段文本是否是合法薪资文本：带单位的区间或「面议」，且不是「X-Y年」经验。 */
export function isSalaryText(text: string): boolean {
  if (/\d+\s*[-~至]\s*\d+\s*年/.test(text)) return false; // 经验区间，不是薪资
  return SALARY_WITH_UNIT_PATTERN.test(text) || SALARY_NEGOTIABLE_PATTERN.test(text);
}

/** 归一薪资文本用于严格相等比较（去空白，K/k 统一大写，去除「·N薪」等尾注差异保留核心区间）。 */
function normalizeSalaryText(text: string | null): string | null {
  if (text === null) return null;
  const match = text.match(SALARY_WITH_UNIT_PATTERN);
  if (match !== null) {
    const unitMatch = text.slice(match.index ?? 0).match(/[Kk千]|万\/?月?|元\/?月?/);
    const unit = (unitMatch?.[0] ?? '').replace(/[Kk]/, 'K');
    return `${match[1]}-${match[2]}${unit}`;
  }
  if (SALARY_NEGOTIABLE_PATTERN.test(text)) return '面议';
  return null;
}

const KANZHUN_PUA_ZERO = 0xe031;
const KANZHUN_PUA_NINE = 0xe03a;

/**
 * 用户真实截图与同页 fieldProbe 逐位核对得到：kanzhun-mix 当前把 U+E031..U+E03A 连续映射为 0..9。
 * 仅在明确的 kanzhun 字体薪资节点上解码；出现范围外 PUA、无单位或非法格式立即返回 null。
 */
export function decodeKanzhunPuaSalary(element: Element | null): string | null {
  if (element === null) return null;
  let fontFamily = '';
  try {
    fontFamily = element.ownerDocument.defaultView?.getComputedStyle(element).fontFamily ?? '';
  } catch {
    return null;
  }
  if (!/kanzhun-(?:mix|regular)/i.test(fontFamily)) return null;
  const raw = element.textContent?.trim() ?? '';
  let decoded = '';
  let mapped = false;
  for (const char of raw) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp >= KANZHUN_PUA_ZERO && cp <= KANZHUN_PUA_NINE) {
      decoded += String(cp - KANZHUN_PUA_ZERO);
      mapped = true;
    } else if ((cp >= 0xe000 && cp <= 0xf8ff) || cp >= 0xf0000) {
      return null;
    } else {
      decoded += char;
    }
  }
  const normalized = normalizeSalaryText(decoded);
  const parsed = parseSalary(normalized);
  return mapped
    && normalized !== null
    && parsed.minK !== null
    && parsed.maxK !== null
    && parsed.minK > 0
    && parsed.maxK >= parsed.minK
    && parsed.maxK <= 1000
    ? decoded
    : null;
}

/**
 * 判断码点是否为异常反爬字符（§六）：C0/C1 控制符、软连字符、零宽/方向格式符(Cf)、
 * BMP 私用区、补充私用区(平面 15/16)、替换符与非字符。按码点判定，避免脆弱字面量字符类。
 */
function isAbnormalCodePoint(cp: number): boolean {
  if (cp <= 0x1f) return true; // C0 控制符
  if (cp === 0xad) return true; // 软连字符
  if (cp >= 0x7f && cp <= 0x9f) return true; // DEL + C1 控制符
  if (cp >= 0x200b && cp <= 0x200f) return true; // 零宽空格/连接符 + LRM/RLM
  if (cp >= 0x202a && cp <= 0x202e) return true; // 方向覆盖格式符
  if (cp >= 0x2060 && cp <= 0x206f) return true; // word joiner + 隐形格式符
  if (cp === 0xfeff) return true; // BOM / 零宽不换行空格
  if (cp >= 0xe000 && cp <= 0xf8ff) return true; // BMP 私用区
  if (cp >= 0xfff9 && cp <= 0xffff) return true; // 非字符 + 替换符 U+FFFD
  if (cp >= 0xf0000) return true; // 补充私用区（平面 15/16）
  return false;
}

/** 逐码点剔除异常反爬字符（正确处理代理对 / 平面 15/16 私用区）。 */
function stripAbnormalChars(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && !isAbnormalCodePoint(cp)) out += ch;
  }
  return out;
}

/**
 * 岗位标题有限规范化（§六）：删除控制/格式/私用区/替换等异常反爬字符与其残留连接符，
 * 合并多余空白；保留正常中英文数字与合法标题符号（括号、+、/、-）。
 * 例如 "中级前端开发工程师□□-□□K·薪" → 清异常字符后尾部只剩连接符/薪资残片，剥离得 "中级前端开发工程师"。
 */
function normalizeRoleTitle(raw: string): string {
  let text = stripAbnormalChars(raw);
  // 剥离因数字被反爬字体隐藏而残留的尾部薪资碎片（如 "-K·薪" / "K薪" / "·14薪"）。
  text = text.replace(/[\s·・.．,，、/\-–—~～]*(?:[Kk千]|万|元)?\s*[·・]?\s*\d*\s*薪\s*$/u, '');
  text = text.replace(/[\s·・.．,，、\-–—~～]*(?:[Kk千]|万|元)\s*$/u, '');
  text = text.replace(/\s+/g, ' ').trim();
  // 去掉仅由异常字符残留形成的尾部连接符（保留标题中间的合法 -、/、+）。
  text = text.replace(/[\s·・.．,，、\-–—~～/]+$/u, '').trim();
  return text;
}

/**
 * 学历标签按「更具体的限定在前」匹配，避免把“统招本科/全日制本科/本科及以上”
 * 过早压缩成普通“本科”。只从卡片/右侧头部的短标签池读取，不从 JD 正文猜测。
 */
const EDUCATION_PATTERNS = [
  /统招本科(?:及以上)?/,
  /全日制本科(?:及以上)?/,
  /统招大专(?:及以上)?/,
  /全日制大专(?:及以上)?/,
  /博士(?:及以上)?/,
  /硕士(?:及以上)?/,
  /本科(?:及以上)?/,
  /大专(?:及以上)?/,
  /中专(?:及以上)?/,
  /高中(?:及以上)?/,
  /学历不限/,
  /初中及以下/,
];

const ACTIVITY_STATUS_SELECTORS = [
  '.job-boss-info .boss-active-time',
  '.job-boss-info .boss-online-tag',
  '.job-boss-info [class*="active"]',
  '.job-boss-info [class*="online"]',
  '.job-boss-info [class*="status"]',
];

function pickExperience(tags: string[]): string | null {
  for (const tag of tags) {
    const match = tag.match(/(经验不限|应届生?|在校\/?应届|\d+\s*-\s*\d+\s*年|\d+\s*年以[上内]|\d+\s*年)/);
    if (match !== null) return match[1]?.replace(/\s+/g, '') ?? null;
  }
  return null;
}

function pickEducation(tags: string[]): string | null {
  const normalizedTags = tags.map((tag) => tag.replace(/\s+/g, ''));
  for (const pattern of EDUCATION_PATTERNS) {
    for (const normalized of normalizedTags) {
      const match = normalized.match(pattern);
      if (match !== null) return match[0] ?? null;
    }
  }
  return null;
}

function pickActivityStatus(root: ParentNode): string | null {
  for (const selector of ACTIVITY_STATUS_SELECTORS) {
    for (const node of Array.from(root.querySelectorAll(selector))) {
      // 真实 BOSS 会把 `.boss-online-tag` 嵌套在招聘者 `.name` 行内；这里只读已命中的
      // 状态节点自身 textContent，不能因祖先是 name 而误删。节点本身若是姓名/机构属性仍拒绝。
      if (node.matches('.boss-name, .job-boss-info .name, .job-boss-info .boss-info-attr')) continue;
      if (node.closest('.job-boss-info .boss-info-attr') !== null) continue;
      if (node.closest('[aria-hidden="true"], [hidden]') !== null) continue;
      const value = textOf(node)?.replace(/\s+/g, ' ').trim() ?? null;
      if (value !== null && value.length <= 30) return value;
    }
  }
  return null;
}

function extractRole(doc: Document, sel: LayoutSelectors, titleRole: string | null): FieldProvenance<string> {
  const dom = firstText(doc, sel.role);
  if (dom !== null) return known(dom, 'boss_dom', 'high');
  if (titleRole !== null) return known(titleRole, 'page_title', 'medium', ['岗位名称来自页面标题解析，请人工确认']);
  return unknownField('未识别岗位名称，需要人工确认');
}

/**
 * 公司名称确定性优先级（§二）：
 *   1. 工商信息「公司名称」标签对应完整值        → boss_business_info / high
 *   2. 公司介绍正文开头可确定的完整企业名称       → boss_company_intro / high
 *   3. 公司详情卡片 / 公司主页链接完整名称        → boss_dom / high
 *   4.（招聘者所属公司完整名称——并入卡片选择器组）
 *   5. 页面 title 的受控解析（含省略号则拒绝）     → page_title / medium
 *   6. unknown
 * 任何来源命中截断值、岗位名、纯地址片段都不采信，继续向下层来源查找。
 */
function extractCompany(
  root: ParentNode,
  sel: LayoutSelectors,
  roleValue: string | null,
  addressValue: string | null,
  titleCompany: string | null,
): FieldProvenance<string> {
  // 1. 工商信息：结构化标签→值，最权威。
  const businessInfo = extractBusinessInfoCompany(root, sel);
  if (businessInfo !== null && isAcceptableCompany(businessInfo, roleValue, addressValue)) {
    return known(businessInfo, 'boss_business_info', 'high');
  }

  // 2. 公司介绍正文开头的完整企业名称。
  const intro = extractCompanyIntroName(root, sel);
  if (intro !== null && isAcceptableCompany(intro, roleValue, addressValue)) {
    return known(intro, 'boss_company_intro', 'high');
  }

  // 3./4. 公司详情卡片 / 公司主页链接 / 招聘者所属公司（并入 sel.company 选择器组）。
  //    交叉校验：截断、等于岗位名、疑似岗位名、纯地址片段一律拒绝，继续向下查找。
  const dom = firstText(root, sel.company);
  if (dom !== null && isAcceptableCompany(dom, roleValue, addressValue)) {
    return known(dom, 'boss_dom', 'high');
  }

  // 5. 页面 title 受控解析——含省略号/截断的 title 公司值一律拒绝，不得以 medium 当正式字段。
  if (titleCompany !== null && isAcceptableCompany(titleCompany, roleValue, addressValue)) {
    return known(titleCompany, 'page_title', 'medium', ['公司名称来自页面标题解析，请人工确认']);
  }

  // 6. 所有可信来源缺失 → unknown（绝不返回截断标题）。
  return unknownField('未识别完整公司名称，需要人工确认');
}

interface CityFields {
  city: FieldProvenance<string>;
  district: FieldProvenance<string>;
  address: FieldProvenance<string>;
}

function extractCity(doc: Document, sel: LayoutSelectors): CityFields {
  const cityTag = firstText(doc, sel.cityTag);
  const addressText = firstText(doc, sel.address);
  const locationRaw = addressText ?? cityTag;
  const parsed = parseCityAddress(locationRaw);

  let city: FieldProvenance<string>;
  if (cityTag !== null && isCleanCityLabel(cityTag)) {
    city = known(cityTag, 'boss_dom', 'high');
  } else if (parsed.city !== null) {
    city = known(parsed.city, 'boss_dom', 'medium', ['城市由地址解析得到，请人工确认']);
  } else {
    city = unknownField('未识别城市，需要人工确认');
  }

  const district = parsed.district !== null
    ? known(parsed.district, 'boss_dom', 'medium', ['区县由地址解析得到，请人工确认'])
    : unknownField<string>('未识别区县');

  const address = addressText !== null
    ? known(addressText, 'boss_dom', 'high')
    : (parsed.address !== null ? known(parsed.address, 'boss_dom', 'medium') : unknownField<string>('未识别详细地址'));

  return { city, district, address };
}

function firstElement(root: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const el = root.querySelector(selector);
    if (el !== null && (el.textContent?.trim().length ?? 0) > 0) return el;
  }
  return null;
}

function extractJd(root: ParentNode, sel: LayoutSelectors): string | null {
  // 只取定向 JD 卡片，天然排除导航/推荐/聊天/广告/页脚（它们不在 JD 容器内）；
  // 用可见文本清洗读取，剔除 <style> 规则与隐藏反爬干扰节点（§七）。
  const el = firstElement(root, sel.jd);
  if (el === null) return null;
  const cleaned = extractCleanText(el);
  return cleaned.length > 0 ? cleaned : null;
}

// 真实 BOSS externalRecordId 除字母数字外还会包含 `-` / `_`；仍严格限制在单一路径段内。
const JOB_ID_PATTERN = /\/job_detail\/([A-Za-z0-9_-]+)\.html(?:[?#]|$)/;

/** 从一个 job_detail 链接的 href 解析稳定 jobId；只接受精确的 /job_detail/<id>.html 形态。 */
export function jobIdFromHref(href: string | null | undefined): string | null {
  if (href === null || href === undefined) return null;
  const match = href.match(JOB_ID_PATTERN);
  return match !== null ? match[1] ?? null : null;
}

interface StableIdentity {
  providerKey: string | null;
  externalRecordId: string | null;
  canonicalSourceUrl: string | null;
}

const NO_IDENTITY: StableIdentity = { providerKey: null, externalRecordId: null, canonicalSourceUrl: null };

export function identityFromJobId(jobId: string): StableIdentity {
  return {
    providerKey: 'boss_zhipin',
    externalRecordId: jobId,
    canonicalSourceUrl: `https://www.zhipin.com/job_detail/${jobId}.html`,
  };
}

/**
 * 独立详情页稳定身份（§六）：直接从当前 URL 的 /job_detail/<id>.html 取 jobId。
 * list_panel 不走此路径——它必须先把右侧详情与选中卡片严格绑定（bindSelectedCardIdentity）。
 */
function extractStableIdentity(url: string, layout: BossLayout): StableIdentity {
  const fromUrl = jobIdFromHref(url);
  if (layout === 'job_detail' && fromUrl !== null) return identityFromJobId(fromUrl);
  return NO_IDENTITY;
}

const JD_KEYWORD_PATTERN = /(职位描述|岗位职责|职位职责|任职要求|岗位要求|工作内容|工作职责|职责描述|岗位介绍)/;
const EXCLUDED_REGION_SELECTOR = 'nav, header, footer, [class*="nav"], [class*="footer"], [class*="recommend"], [class*="chat"], [class*="im-"], .job-list-container, .job-list-wrapper';

/**
 * 右侧当前岗位详情面板选择器（正向锚点）。真实 BOSS `/web/geek/jobs` 把整页结果容器命名为
 * `recommend-result-job` / `job-recommend-result`（含 [class*="recommend"]），它同时包住左侧列表
 * 与右侧详情。右侧详情本身是独立的 `.job-detail-box / .job-detail-container / .job-detail-body`。
 */
const DETAIL_PANEL_SELECTOR = '.job-detail-box, .job-detail-container, .job-detail-body';

/**
 * 节点是否处于「应排除区域」。语义（§三）：排除「节点确实位于导航/页脚/聊天/推荐子块/左侧列表列
 * 或岗位卡片内部」；不排除「节点只是与左侧列表共享了一个宽泛的双栏/结果页外层 wrapper」。
 *
 * 实现：先看是否命中排除选择器（closest 只返回祖先或自身）。若命中的排除祖先其实「包住了整个
 * 右侧详情面板」（即详情面板在该排除祖先之内），说明这是共享外层 wrapper，右侧详情不应被排除；
 * 反之（节点无详情面板祖先，或排除区在详情面板内部的真实子块）才排除。
 */
function isInExcludedRegion(el: Element): boolean {
  if (typeof el.closest !== 'function') return false;
  const excludedAncestor = el.closest(EXCLUDED_REGION_SELECTOR);
  if (excludedAncestor === null) return false;
  const detailPanel = el.closest(DETAIL_PANEL_SELECTOR);
  if (detailPanel === null) return true;
  // 排除祖先包住详情面板 → 共享外层 wrapper，不排除；否则（排除区在详情面板内部）→ 排除。
  return excludedAncestor.contains(detailPanel) ? false : true;
}

/** 从一段文本里提取岗位标题候选（去异常字符、剥离薪资残片、限长、排除公司/城市词）。 */
export function titleCandidateFrom(text: string): string | null {
  const normalized = normalizeRoleTitle(text);
  if (normalized.length === 0 || normalized.length > 40) return null;
  if (/公司|集团|有限|责任/.test(normalized)) return null;
  return normalized;
}

/** 强岗位后缀：用于把「独立岗位标题节点」从「标题+城市+经验+学历拼接节点」里区分出来（§三.3）。 */
const ROLE_SUFFIX_PATTERN = /(工程师|架构师|设计师|分析师|经理|主管|总监|专员|顾问|助理|专家|负责人|实习生|研究员|运维|测试|讲师|编辑|策划师?|开发者)$/;

interface DomLikeRect { left: number; top: number; width: number; height: number; }

/** 读取元素布局矩形；无 getBoundingClientRect 或退化为 0 尺寸（happy-dom/未布局）时返回 null，届时跳过空间约束。 */
function rectOf(el: Element): DomLikeRect | null {
  const fn = (el as unknown as { getBoundingClientRect?: () => DomLikeRect | null | undefined }).getBoundingClientRect;
  if (typeof fn !== 'function') return null;
  let rect: DomLikeRect | null | undefined;
  try {
    rect = fn.call(el);
  } catch {
    return null;
  }
  if (rect === null || rect === undefined) return null;
  const width = Number(rect.width) || 0;
  const height = Number(rect.height) || 0;
  if (width === 0 && height === 0) return null;
  return { left: Number(rect.left) || 0, top: Number(rect.top) || 0, width, height };
}

function viewportWidth(doc: Document): number | null {
  const w = (doc.defaultView as unknown as { innerWidth?: number } | null | undefined)?.innerWidth;
  return typeof w === 'number' && w > 0 ? w : null;
}

/**
 * 空间约束（§三.2，确定性、可降级）：有布局信息时要求面板中心位于视口中线右侧、宽度不横跨整页；
 * 无布局信息（测试环境或未布局）时返回 true，交由结构信号（DOM 包含关系、JD 关键词、标题）把关。
 */
function panelSpatialOk(el: Element, doc: Document): boolean {
  const vw = viewportWidth(doc);
  const rect = rectOf(el);
  if (vw === null || rect === null) return true;
  const centerX = rect.left + rect.width / 2;
  if (centerX < vw / 2) return false;
  if (rect.width >= vw * 0.92) return false;
  return true;
}

/** 元素是否为整页级容器（不得作为右侧详情面板）。 */
function isBodyLevel(el: Element): boolean {
  const tag = el.tagName?.toLowerCase() ?? '';
  return tag === 'body' || tag === 'html' || tag === 'main';
}

/** 容器是否包含左侧岗位列表（含列表容器或 ≥2 张岗位卡片），用于阻止面板扩大到覆盖左列表。 */
function containsJobList(el: Element): boolean {
  if (typeof el.querySelector === 'function' && el.querySelector('.job-list-container, .job-list-wrapper') !== null) {
    return true;
  }
  return el.querySelectorAll(CARD_SELECTOR).length >= 2;
}

/** 一段文本是否是「有意义的 JD 正文」：含 JD 语义标题，长度达标，且有多条职责/要求信号。 */
const JD_MIN_LENGTH = 12;
function isMeaningfulJd(text: string): boolean {
  if (text.length < JD_MIN_LENGTH) return false;
  if (!JD_KEYWORD_PATTERN.test(text)) return false;
  const keywordHits = (text.match(new RegExp(JD_KEYWORD_PATTERN.source, 'g')) ?? []).length;
  const itemSeparators = (text.match(/[；;]|[0-9][.、)）]/g) ?? []).length;
  return keywordHits >= 2 || itemSeparators >= 2;
}

/**
 * §三.1 找 JD 正文锚点：可见、含 JD 语义标题、正文达标、含多条职责/要求，且不在左侧列表/导航/
 * 推荐/聊天/页脚等被排除区域内，也不包含整个左侧岗位列表。按正文体量升序，优先最小最具体的容器。
 */
function findJdBodyContainers(doc: Document): Element[] {
  const out: Element[] = [];
  doc.querySelectorAll('div, section, article, p, dd, li').forEach((el) => {
    if (isInExcludedRegion(el)) return;
    if (containsJobList(el)) return;
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (isMeaningfulJd(text)) out.push(el);
  });
  out.sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
  return out;
}

function collectJdKeywords(bodies: Element[]): string[] {
  const set = new Set<string>();
  const re = new RegExp(JD_KEYWORD_PATTERN.source, 'g');
  for (const body of bodies.slice(0, 3)) {
    for (const match of (body.textContent ?? '').matchAll(re)) {
      if (match[0] !== undefined) set.add(match[0]);
    }
  }
  return [...set];
}

/** 详情面板中「JD 正文之前」的头部区域元素（排除含 JD 的祖先与被排除区域）。 */
function elementsBeforeJd(panel: Element, jdBody: Element): Element[] {
  const all = Array.from(panel.querySelectorAll('*'));
  const idx = all.indexOf(jdBody);
  const before = idx >= 0 ? all.slice(0, idx) : all;
  return before.filter((el) => !el.contains(jdBody) && !isInExcludedRegion(el));
}

/**
 * §三.3/§五 从头部区域挑选岗位标题：只在 JD 正文之前的头部区域里找。优先「以强岗位后缀结尾」的
 * 独立标题节点（tier0），把它从「标题+城市+经验+学历」拼接节点里区分出来；同层取最短、最靠前者。
 * 岗位标题定位完全不依赖薪资是否可解析（§三.3）。
 */
function pickRoleTitle(candidates: Element[]): { el: Element; raw: string; role: string } | null {
  const scored: Array<{ el: Element; raw: string; role: string; tier: number; len: number; order: number }> = [];
  candidates.forEach((el, order) => {
    const raw = extractCleanText(el);
    const role = titleCandidateFrom(raw);
    if (role === null || !looksLikeJobTitle(role)) return;
    const tier = ROLE_SUFFIX_PATTERN.test(role) ? 0 : 1;
    scored.push({ el, raw, role, tier, len: role.length, order });
  });
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.tier - b.tier || a.len - b.len || a.order - b.order);
  const best = scored[0]!;
  return { el: best.el, raw: best.raw, role: best.role };
}

/** §四.1 头部区域内可读的带单位薪资（取最短的薪资文本节点，避免命中拼接的大段头部文本）。 */
interface SalaryTextResult { text: string; decodedFromPua: boolean }

function findHeaderSalaryText(headerEls: Element[]): SalaryTextResult | null {
  let best: string | null = null;
  for (const el of headerEls) {
    const text = el.textContent?.trim() ?? '';
    if (text.length > 0 && text.length <= 40 && isSalaryText(text)) {
      if (best === null || text.length < best.length) best = text;
    }
  }
  if (best !== null) return { text: best, decodedFromPua: false };
  for (const el of headerEls) {
    if (!el.matches('.job-salary, .salary, [class*="salary"]')) continue;
    const decoded = decodeKanzhunPuaSalary(el);
    if (decoded !== null) return { text: decoded, decodedFromPua: true };
  }
  return null;
}

/** §四.3 页面已提供的可访问薪资文本（aria-label / title / data-*），仍要求带单位。 */
function findAccessibleSalaryText(panel: Element): string | null {
  const nodes = panel.querySelectorAll('[aria-label], [title], [data-salary], [data-v-salary]');
  for (const el of Array.from(nodes)) {
    for (const attr of ['aria-label', 'title', 'data-salary', 'data-v-salary']) {
      const value = typeof el.getAttribute === 'function' ? el.getAttribute(attr) : null;
      if (value !== null && value.length <= 60 && isSalaryText(value)) return value;
    }
  }
  return null;
}

interface RightPanelHeader {
  container: Element;
  /** 定位到的右侧 JD 正文容器（visibleText / JD 只能来自这里，§八）。 */
  jdBody: Element;
  role: FieldProvenance<string>;
  rawRoleText: string | null;
  salary: { minK: number | null; maxK: number | null; period: string | null };
  rawSalaryText: string | null;
  /** 右侧头部/可访问属性中可读的薪资（不可读时为 null，绝不猜测数字）。 */
  headerSalaryReadable: boolean;
  salaryDecodedFromPua: boolean;
}

/** EXCLUDED_REGION_SELECTOR 拆成单个 selector，供探针逐个测试命中项。 */
const EXCLUDED_REGION_SELECTOR_LIST = EXCLUDED_REGION_SELECTOR.split(',').map((s) => s.trim()).filter((s) => s.length > 0);

function styleProbe(el: Element, doc: Document): { display: string | null; visibility: string | null; opacity: string | null } {
  try {
    const win = doc.defaultView as unknown as { getComputedStyle?: (e: Element) => { display?: string; visibility?: string; opacity?: string } | null } | null;
    if (win !== null && typeof win.getComputedStyle === 'function') {
      const cs = win.getComputedStyle(el);
      if (cs !== null && cs !== undefined) {
        return { display: cs.display ?? null, visibility: cs.visibility ?? null, opacity: cs.opacity ?? null };
      }
    }
  } catch {
    // getComputedStyle 不可用：留空。
  }
  return { display: null, visibility: null, opacity: null };
}

function isInShadowRoot(el: Element): boolean {
  try {
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    if (root === null || root === el.ownerDocument) return false;
    const ctorName = (root as unknown as { constructor?: { name?: string } }).constructor?.name ?? '';
    return /ShadowRoot/.test(ctorName);
  } catch {
    return false;
  }
}

function excludedInfo(el: Element): { excluded: boolean; selector: string | null; ancestor: JdNodeProbe['excludedAncestor'] } {
  if (typeof el.closest !== 'function') return { excluded: false, selector: null, ancestor: null };
  for (const sel of EXCLUDED_REGION_SELECTOR_LIST) {
    let anc: Element | null = null;
    try {
      anc = el.closest(sel);
    } catch {
      anc = null;
    }
    if (anc !== null) {
      return {
        excluded: true,
        selector: sel,
        ancestor: { tag: anc.tagName?.toLowerCase() ?? '', className: (anc.getAttribute('class') ?? '').slice(0, 160), rect: rectOf(anc) },
      };
    }
  }
  return { excluded: false, selector: null, ancestor: null };
}

function ancestorChainProbe(el: Element, jdRe: RegExp): JdNodeProbe['ancestors'] {
  const chain: JdNodeProbe['ancestors'] = [];
  let node: Element | null = el.parentElement;
  for (let i = 0; i < 8 && node !== null; i += 1) {
    const hasListContainer = typeof node.querySelector === 'function' && node.querySelector('.job-list-container, .job-list-wrapper') !== null;
    const cards = node.querySelectorAll(CARD_SELECTOR).length;
    chain.push({
      tag: node.tagName?.toLowerCase() ?? '',
      className: (node.getAttribute('class') ?? '').slice(0, 160),
      rect: rectOf(node),
      containsLeftCards: hasListContainer || cards >= 2,
      containsJdKeyword: jdRe.test(node.textContent ?? ''),
      bodyLevel: isBodyLevel(node),
    });
    node = node.parentElement;
  }
  return chain;
}

/**
 * §四 构建 JD 定位失败结构探针：找命中 JD 关键词的最内层节点（最多 10 条），逐条记录脱敏结构、
 * rect、样式、excluded 命中项与祖先链。只读，不改 DOM，不含完整 JD/HTML/PII/Token。
 */
function buildJdLocateProbe(doc: Document): { probe: JdNodeProbe[]; keywordElementCount: number } {
  const re = new RegExp(JD_KEYWORD_PATTERN.source);
  const found = new Set<Element>();
  try {
    const body = doc.body;
    const walker = body !== null && body !== undefined && typeof doc.createTreeWalker === 'function'
      ? doc.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */)
      : null;
    if (walker !== null) {
      let n: Node | null;
      while ((n = walker.nextNode()) !== null && found.size < 60) {
        if (re.test(n.textContent ?? '')) {
          const p = (n as unknown as { parentElement?: Element | null }).parentElement ?? null;
          if (p !== null) found.add(p);
        }
      }
    }
  } catch {
    // TreeWalker 不可用：走 querySelectorAll 兜底。
  }
  if (found.size === 0) {
    doc.querySelectorAll('div, section, article, p, dd, li, span, h1, h2, h3, h4, td').forEach((el) => {
      if (found.size >= 60) return;
      if (re.test(el.textContent ?? '')) found.add(el);
    });
  }
  const els = [...found].sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0)).slice(0, 10);
  const probe = els.map((el): JdNodeProbe => {
    const ex = excludedInfo(el);
    const style = styleProbe(el, doc);
    const rawText = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    const ariaLabel = typeof el.getAttribute === 'function' ? el.getAttribute('aria-label') : null;
    return {
      tag: el.tagName?.toLowerCase() ?? '',
      id: (typeof el.getAttribute === 'function' ? el.getAttribute('id') : null) || null,
      className: (el.getAttribute('class') ?? '').slice(0, 160),
      ariaRole: typeof el.getAttribute === 'function' ? el.getAttribute('role') : null,
      ariaLabel: ariaLabel !== null ? ariaLabel.slice(0, 40) : null,
      textPrefix: rawText.slice(0, 40),
      innerTextLen: rawText.length,
      rect: rectOf(el),
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      inIframe: el.ownerDocument !== doc,
      inShadowRoot: isInShadowRoot(el),
      excluded: ex.excluded,
      excludedSelector: ex.selector,
      excludedAncestor: ex.ancestor,
      ancestors: ancestorChainProbe(el, re),
    };
  });
  return { probe, keywordElementCount: found.size };
}

type LocateResult =
  | { header: RightPanelHeader; locate: null }
  | { header: null; locate: ListPanelLocateDiagnostics };

/**
 * §三 右侧详情「当前岗位头部」JD-first 锚定（类名无关，薪资不再是锚点）：
 * 1. 找含 JD 语义标题的最小 JD 正文容器；
 * 2. 从 JD 锚点向上找「JD 正文之上存在岗位头部、且不覆盖左侧列表、不扩大到整页」的最小面板；
 * 3. 在面板头部区域（JD 之前）提取岗位标题；薪资从头部可读节点/可访问属性读取，不可读则留空。
 */
function locateRightPanel(doc: Document): LocateResult {
  const jdBodies = findJdBodyContainers(doc);
  const jdKeywords = collectJdKeywords(jdBodies);
  const candidateRects: ListPanelLocateDiagnostics['candidateRects'] = [];
  const pushRect = (role: 'jd' | 'panel', el: Element): void => {
    if (candidateRects.length >= 6) return;
    const rect = rectOf(el);
    if (rect !== null) {
      candidateRects.push({ role, left: Math.round(rect.left), top: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) });
    }
  };

  const fail = (rejectedReason: string, panelCandidateCount: number, jdContainerWithoutHeader: boolean): LocateResult => {
    // §四 仅在定位失败时运行结构探针（避免污染成功路径 / 无谓开销）。
    const { probe, keywordElementCount } = buildJdLocateProbe(doc);
    return {
      header: null,
      locate: {
        layoutType: 'list_panel',
        jdContainerCandidateCount: jdBodies.length,
        panelCandidateCount,
        jdKeywordsFound: jdKeywords,
        candidateRects,
        rejectedReason,
        salaryRequiredForAnchor: false,
        jdContainerWithoutHeader,
        keywordElementCount,
        probe,
      },
    };
  };

  if (jdBodies.length === 0) {
    return fail('未找到含「职位描述/岗位职责/任职要求」等语义标题的右侧详情正文容器', 0, false);
  }

  let panelCandidateCount = 0;
  for (const jdBody of jdBodies.slice(0, 5)) {
    pushRect('jd', jdBody);
    let node: Element | null = jdBody.parentElement;
    for (let depth = 0; depth < 8 && node !== null; depth += 1) {
      if (isBodyLevel(node) || containsJobList(node)) break;
      const headerEls = elementsBeforeJd(node, jdBody);
      const title = pickRoleTitle(headerEls);
      if (title !== null) {
        panelCandidateCount += 1;
        pushRect('panel', node);
        if (panelSpatialOk(node, doc)) {
          const headerSalary = findHeaderSalaryText(headerEls);
          const accessibleSalary = headerSalary === null ? findAccessibleSalaryText(node) : null;
          const salaryText = headerSalary?.text ?? accessibleSalary;
          const parsed = salaryText !== null ? parseSalary(salaryText) : { minK: null, maxK: null, period: null };
          return {
            header: {
              container: node,
              jdBody,
              role: known(title.role, 'boss_dom', 'high'),
              rawRoleText: title.raw,
              salary: parsed,
              rawSalaryText: salaryText,
              headerSalaryReadable: parsed.minK !== null,
              salaryDecodedFromPua: headerSalary?.decodedFromPua ?? false,
            },
            locate: null,
          };
        }
      }
      node = node.parentElement;
    }
  }

  const jdContainerWithoutHeader = panelCandidateCount === 0;
  return fail(
    jdContainerWithoutHeader
      ? '定位到含 JD 的右侧容器，但其 JD 正文之上未找到可识别的岗位头部标题'
      : '右侧详情面板候选未通过空间约束（不在视口右侧或横跨整页）',
    panelCandidateCount,
    jdContainerWithoutHeader,
  );
}

/** 收集容器内所有 job_detail 链接的 jobId，唯一时返回，否则返回 null（多义不猜测）。 */
export function uniqueJobIdWithin(root: ParentNode): string | null {
  const ids = new Set<string>();
  root.querySelectorAll('a[href]').forEach((a) => {
    const id = jobIdFromHref(a.getAttribute('href'));
    if (id !== null) ids.add(id);
  });
  return ids.size === 1 ? [...ids][0] ?? null : null;
}

export interface CardInfo {
  el: Element;
  role: string | null;
  salaryNorm: string | null;
  salaryDecodedFromPua: boolean;
  company: string | null;
  jobId: string | null;
  isSelected: boolean;
  /** 卡片上可读的经验/学历标签（批量选卡字段来源，§五）。 */
  experience: string | null;
  education: string | null;
  /** 由 jobId 派生的稳定 canonical URL（无 query/securityId）。 */
  canonicalSourceUrl: string | null;
}

export const CARD_SELECTOR = '.job-list-container .job-card, .job-list-container li, .job-card-box .job-card, li.job-card-wrapper, [class*="job-card-item"]';
const CARD_SELECTED_SUFFIX = '.selected, .active, [class*="selected"], [class*="active"]';

/** 读取一张岗位卡片的 role/salary/company/experience/education/jobId/isSelected 元信息。 */
export function readCardInfo(card: Element): CardInfo {
  const roleEl = card.querySelector('.job-name, .name, .job-title, .position-name, h3, h2, b, strong');
  const rawRole = roleEl !== null ? extractCleanText(roleEl) : null;
  const role = rawRole !== null ? titleCandidateFrom(rawRole) : null;

  const salaryEl = card.querySelector('.salary, .job-salary, .red, .money, [class*="salary"]');
  const rawSalary = salaryEl?.textContent?.trim() ?? null;
  // BOSS 可能把可访问的明文薪资放在 aria/title/data-*，而可见 textContent 使用 PUA 字体。
  // 仍只接受带薪资单位的受控文本；明文缺失时只允许已由真实页证据确认的 kanzhun 固定数字映射。
  const readableSalary = normalizeSalaryText(rawSalary) ?? normalizeSalaryText(findAccessibleSalaryText(card));
  const decodedPuaSalary = readableSalary === null ? decodeKanzhunPuaSalary(salaryEl) : null;
  const salaryNorm = readableSalary ?? normalizeSalaryText(decodedPuaSalary);
  const salaryDecodedFromPua = readableSalary === null && salaryNorm !== null;

  // 真实 BOSS 列表页把公司展示名放在卡片 footer 的 a.boss-info，且链接明确指向 /gongsi/。
  // 只接受这个结构化公司链接，避免把同卡片中的 boss-name（招聘者姓名）误当公司。
  const companyEl = card.querySelector('a.boss-info[href*="/gongsi/"], .company-name, .company, [class*="company-name"]');
  const rawCompany = companyEl?.textContent?.trim() ?? null;
  const company = rawCompany !== null && rawCompany.length >= 2 ? rawCompany : null;

  const jobId = uniqueJobIdWithin(card);

  const cls = (card.getAttribute('class') ?? '').toLowerCase();
  const isSelected = cls.includes('selected') || cls.includes('active');

  // 卡片经验/学历：从卡片内短文本标签池派生（不猜测、带单位规则复用）。
  const cardTags = splitContainerTagText(card);
  const experience = pickExperience(cardTags);
  const education = pickEducation(cardTags);

  return {
    el: card, role, salaryNorm, salaryDecodedFromPua, company, jobId, isSelected, experience, education,
    canonicalSourceUrl: jobId !== null ? identityFromJobId(jobId).canonicalSourceUrl : null,
  };
}

interface CardBindingResult {
  identity: StableIdentity;
  company: string | null;
  /** 绑定卡片可读薪资（右侧详情薪资被反爬字体隐藏时的回退来源）。 */
  cardSalary: { minK: number | null; maxK: number | null; period: string | null };
  cardSalaryDecodedFromPua: boolean;
  diagnostics: ListPanelDiagnostics;
  blockingIssues: string[];
}

/** §六 薪资交叉校验：两侧都可读且相等=matched；相等失败=mismatched；任一侧不可读=unavailable。 */
function crossCheckSalary(rightNorm: string | null, cardNorm: string | null): SalaryCrossCheck {
  if (rightNorm === null || cardNorm === null) return 'unavailable';
  return rightNorm === cardNorm ? 'matched' : 'mismatched';
}

function makeBlocking(
  reason: string,
  rightPanelRole: string | null,
  rightPanelSalaryNorm: string | null,
  selectedStateDetected: boolean,
  sc: CardInfo | null,
): CardBindingResult {
  const selectedCardRole = sc?.role ?? null;
  return {
    identity: NO_IDENTITY,
    company: null,
    cardSalary: { minK: null, maxK: null, period: null },
    cardSalaryDecodedFromPua: false,
    diagnostics: {
      rightPanelRole, rightPanelSalary: rightPanelSalaryNorm,
      selectedCardRole, selectedCardSalary: sc?.salaryNorm ?? null, selectedCardCompany: sc?.company ?? null,
      selectedStateDetected,
      roleMatch: selectedCardRole !== null && rightPanelRole !== null && normalizeRoleTitle(selectedCardRole) === rightPanelRole,
      salaryCrossCheck: crossCheckSalary(rightPanelSalaryNorm, sc?.salaryNorm ?? null),
      identityMatch: false, identitySource: 'none', externalRecordId: null,
      locate: null,
    },
    blockingIssues: [reason],
  };
}

function bindOk(
  card: CardInfo,
  rightPanelRole: string | null,
  rightPanelSalaryNorm: string | null,
  selectedStateDetected: boolean,
  identitySource: 'selected_card' | 'unique_exact_match',
): CardBindingResult {
  return {
    identity: identityFromJobId(card.jobId!),
    company: card.company,
    cardSalary: parseSalary(card.salaryNorm),
    cardSalaryDecodedFromPua: card.salaryDecodedFromPua,
    diagnostics: {
      rightPanelRole, rightPanelSalary: rightPanelSalaryNorm,
      selectedCardRole: card.role, selectedCardSalary: card.salaryNorm, selectedCardCompany: card.company,
      selectedStateDetected,
      roleMatch: true,
      salaryCrossCheck: crossCheckSalary(rightPanelSalaryNorm, card.salaryNorm),
      identityMatch: true, identitySource, externalRecordId: card.jobId,
      locate: null,
    },
    blockingIssues: [],
  };
}

/**
 * §四/§七 将右侧详情头部与左侧选中岗位卡片严格绑定。
 *
 * 现实约束：BOSS 用私用区(PUA)自定义字体渲染薪资数字——人眼可见「11-13K」，但 textContent 得到乱码，
 * 故右侧详情薪资可能不可读(rightPanelSalaryNorm=null)。因此匹配以 role 完整相等为主键，薪资仅在
 * 「两侧都可读」时做严格交叉校验（不一致→阻塞）；右侧薪资不可读时记 salaryCrossCheck=unavailable，
 * 不因缺少薪资否决唯一 selected 卡片，也不放宽 role 唯一性要求（§五.4）。
 *
 * 绑定优先级：
 * 1. selected/active 卡片，其 role 与右侧头部完整相等（若两侧薪资都可读还须相等）；
 * 2. 无状态标记时，role 完整相等（+可读薪资相等）的唯一卡片；
 * 3. 否则 externalRecordId=null + 阻塞，说明无法唯一绑定。
 * 禁止：模糊相似度、仅 selected 状态而 role 不一致、role 匹配但两侧可读薪资不一致。
 */
function bindSelectedCardIdentity(
  rightPanelRole: string | null,
  rightPanelSalaryNorm: string | null,
  doc: Document,
): CardBindingResult {
  const cards: CardInfo[] = [];
  doc.querySelectorAll(CARD_SELECTOR).forEach((card) => cards.push(readCardInfo(card)));
  if (cards.length === 0) {
    doc.querySelectorAll(CARD_SELECTED_SUFFIX).forEach((card) => cards.push(readCardInfo(card)));
  }
  const selectedStateDetected = cards.some((c) => c.isSelected);

  const block = (reason: string, sc: CardInfo | null): CardBindingResult => makeBlocking(
    reason, rightPanelRole, rightPanelSalaryNorm, selectedStateDetected, sc,
  );

  if (rightPanelRole === null) {
    return block('右侧详情头部无法解析岗位标题，无法与选中卡片绑定', null);
  }

  // role 完整相等；两侧薪资都可读时须相等（一侧不可读则跳过薪资校验，交由 role 唯一性把关）。
  const roleMatches = (card: CardInfo): boolean => card.role !== null && normalizeRoleTitle(card.role) === rightPanelRole;
  const salaryConflict = (card: CardInfo): boolean => (
    rightPanelSalaryNorm !== null && card.salaryNorm !== null && card.salaryNorm !== rightPanelSalaryNorm
  );

  // 路径 1：selected/active 卡片。
  const selectedCards = cards.filter((c) => c.isSelected);
  if (selectedCards.length >= 1) {
    const matching = selectedCards.filter((c) => roleMatches(c) && !salaryConflict(c));
    if (matching.length === 1) {
      const card = matching[0]!;
      if (card.jobId === null) return block('当前 selected 卡片无 /job_detail/<id>.html 链接，无法建立稳定来源身份', card);
      return bindOk(card, rightPanelRole, rightPanelSalaryNorm, selectedStateDetected, 'selected_card');
    }
    // 有 selected 卡片但与右侧 role/薪资不一致 → 串位，阻塞。
    const sc = selectedCards[0]!;
    return block(
      `Selected 卡片 role="${sc.role ?? '?'}" salary="${sc.salaryNorm ?? '?'}" 与右侧详情 role="${rightPanelRole}" salary="${rightPanelSalaryNorm ?? '(不可读)'}" 不一致，无法唯一绑定当前岗位`,
      sc,
    );
  }

  // 路径 2：无 selected 状态时，role 完整相等（薪资不冲突）的唯一卡片。
  const exactMatches = cards.filter((c) => roleMatches(c) && !salaryConflict(c));
  if (exactMatches.length === 1) {
    const card = exactMatches[0]!;
    if (card.jobId === null) return block('精确匹配卡片无 /job_detail/<id>.html 链接，无法建立稳定来源身份', card);
    return bindOk(card, rightPanelRole, rightPanelSalaryNorm, selectedStateDetected, 'unique_exact_match');
  }
  if (exactMatches.length > 1) {
    return block(`列表中有 ${exactMatches.length} 张卡片与右侧详情精确匹配，无法唯一绑定当前岗位`, null);
  }

  return block('无法唯一绑定当前详情与选中岗位卡片：未找到 role 完整相等且有 job_detail 链接的卡片', null);
}
function extractCityWithin(container: Element): CityFields {
  const nodes = Array.from(container.querySelectorAll('*'));
  for (const node of nodes) {
    const text = node.textContent?.trim() ?? '';
    if (text.length > 0 && text.length <= 20 && isCleanCityLabel(text)) {
      return { city: known(text, 'boss_dom', 'high'), district: unknownField<string>('未识别区县'), address: unknownField<string>('未识别详细地址') };
    }
  }
  // 退而求其次：在短文本节点里做受控 city/district 解析（如「苏州·吴中区…」）。
  for (const node of nodes) {
    const text = node.textContent?.trim() ?? '';
    if (text.length > 0 && text.length <= 40) {
      const parsed = parseCityAddress(text);
      if (parsed.city !== null) {
        return {
          city: known(parsed.city, 'boss_dom', 'medium', ['城市由地点文本解析得到，请人工确认']),
          district: parsed.district !== null ? known(parsed.district, 'boss_dom', 'medium', ['区县由地点文本解析得到，请人工确认']) : unknownField<string>('未识别区县'),
          address: parsed.address !== null ? known(parsed.address, 'boss_dom', 'medium') : unknownField<string>('未识别详细地址'),
        };
      }
    }
  }
  return { city: unknownField('未识别城市，需要人工确认'), district: unknownField<string>('未识别区县'), address: unknownField<string>('未识别详细地址') };
}

/**
 * list_panel 结构化提取（§三/§四/§五/§六/§七）：
 * 1. 锚定右侧详情当前岗位头部（role/salary/city/tags/JD 全部来自这一个头部/面板）；
 * 2. 把该头部与左侧 selected 卡片按 role+salary 精确绑定，取 company/身份；
 * 3. 身份一致性硬校验（identityMatch）不通过时阻塞写入，且 externalRecordId=null。
 */
function extractListPanel(_url: string, doc: Document): BossExtraction {
  const located = locateRightPanel(doc);

  if (located.header === null) {
    const diagnostics: ListPanelDiagnostics = {
      rightPanelRole: null, rightPanelSalary: null, selectedCardRole: null,
      selectedCardSalary: null, selectedCardCompany: null,
      selectedStateDetected: false, roleMatch: false, salaryCrossCheck: 'unavailable',
      identityMatch: false, identitySource: 'none', externalRecordId: null,
      locate: located.locate,
    };
    return {
      layout: 'list_panel',
      role: unknownField('未定位到右侧当前岗位详情头部，需人工确认'),
      company: unknownField('未定位到右侧当前岗位详情头部，需人工确认'),
      city: unknownField('未识别城市'),
      district: unknownField('未识别区县'),
      address: unknownField('未识别详细地址'),
      salaryMinK: unknownField<number>('未识别薪资下限'),
      salaryMaxK: unknownField<number>('未识别薪资上限'),
      salaryPeriod: unknownField<string>('未识别薪资周期'),
      experienceRequirement: unknownField<string>('未识别经验要求'),
      educationRequirement: unknownField<string>('未识别学历要求'),
      activityStatus: unknownField<string>('未识别招聘者活跃度'),
      // §八 定位失败：绝不把整页岗位列表文本当作 JD 正文，jdText 置空，由上层给出诊断摘要。
      jdText: null,
      ...NO_IDENTITY,
      blockingIssues: ['未定位到右侧当前岗位详情头部，无法建立当前岗位锚点'],
      listPanelDiagnostics: diagnostics,
    };
  }

  const header = located.header;
  const container = header.container;
  const rightPanelRole = header.role.value;
  const rightPanelSalaryNorm = header.headerSalaryReadable ? normalizeSalaryText(header.rawSalaryText) : null;

  // §四/§七 绑定选中卡片 → 身份 + 公司。
  const binding = bindSelectedCardIdentity(rightPanelRole, rightPanelSalaryNorm, doc);

  const cityFields = extractCityWithin(container);
  // 公司来源顺序（§七）：绑定卡片公司 → 右侧工商信息/公司介绍/公司卡片 → unknown。列表页 pageTitle 绝不使用。
  let company: FieldProvenance<string>;
  if (binding.company !== null && isAcceptableCompany(binding.company, rightPanelRole, cityFields.address.value)) {
    company = known(binding.company, 'boss_dom', 'high');
  } else {
    company = extractCompany(container, LIST_PANEL_CONTAINER_SELECTORS, rightPanelRole, cityFields.address.value, null);
  }

  // 薪资优先级（§四）：右侧详情头部可读单位薪资 → 已绑定 selected 卡片可读薪资 → 均不可读则 null（不猜数字）。
  const salaryFromHeader = header.salary.minK !== null;
  const salary = salaryFromHeader ? header.salary : binding.cardSalary;
  const salaryDecodedFromPua = salaryFromHeader
    ? header.salaryDecodedFromPua
    : binding.cardSalaryDecodedFromPua;
  const salarySource: FieldSource = salaryFromHeader ? 'boss_dom' : 'selected_card';
  const salaryConfidence: FieldConfidence = salaryDecodedFromPua ? 'medium' : 'high';
  const salaryDecodeIssues = salaryDecodedFromPua
    ? ['薪资由 BOSS kanzhun PUA 字符映射得到，请人工确认']
    : [];
  const salaryUnknownIssue = salary.minK === null ? ['右侧薪资不可读（可能为反爬字体），请在预览中人工纠正'] : [];
  const tags = allTexts(container, LIST_PANEL_CONTAINER_SELECTORS.tags);
  const tagPool = tags.length > 0 ? tags : splitContainerTagText(container);
  const experience = pickExperience(tagPool);
  const education = pickEducation(tagPool);
  const activityStatus = pickActivityStatus(container);
  // §八 JD 只取右侧详情面板内定位到的最小 JD 正文子容器，绝不含左侧列表/导航/推荐/广告/页脚。
  const jd = extractJdWithin(container);

  const blockingIssues = [...binding.blockingIssues];

  return {
    layout: 'list_panel',
    role: header.role,
    company,
    city: cityFields.city,
    district: cityFields.district,
    address: cityFields.address,
    salaryMinK: salary.minK !== null
      ? known(salary.minK, salarySource, salaryConfidence, salaryDecodeIssues)
      : { value: null, source: 'none', confidence: 'low', qualityIssues: salaryUnknownIssue.length > 0 ? salaryUnknownIssue : ['未识别薪资下限'] },
    salaryMaxK: salary.maxK !== null
      ? known(salary.maxK, salarySource, salaryConfidence, salaryDecodeIssues)
      : { value: null, source: 'none', confidence: 'low', qualityIssues: salaryUnknownIssue.length > 0 ? salaryUnknownIssue : ['未识别薪资上限'] },
    salaryPeriod: salary.period !== null
      ? known(salary.period, salarySource, salaryConfidence, salaryDecodeIssues)
      : unknownField<string>('未识别薪资周期'),
    experienceRequirement: experience !== null ? known(experience, 'boss_dom', 'high') : unknownField<string>('未识别经验要求'),
    educationRequirement: education !== null ? known(education, 'boss_dom', 'high') : unknownField<string>('未识别学历要求'),
    activityStatus: activityStatus !== null ? known(activityStatus, 'boss_dom', 'high') : unknownField<string>('未识别招聘者活跃度'),
    jdText: jd,
    ...binding.identity,
    blockingIssues,
    listPanelDiagnostics: binding.diagnostics,
  };
}

/** JD：在容器内优先取定向 JD 卡片；找不到卡片时取「含 JD 关键词的最小子容器」，均做可见文本清洗。 */
function extractJdWithin(container: Element): string | null {
  const direct = extractJd(container, LIST_PANEL_CONTAINER_SELECTORS);
  if (direct !== null) return direct;
  let best: Element | null = null;
  container.querySelectorAll('div, section, p').forEach((el) => {
    const text = el.textContent ?? '';
    if (JD_KEYWORD_PATTERN.test(text)) {
      if (best === null || (el.textContent?.length ?? 0) < (best.textContent?.length ?? 0)) best = el;
    }
  });
  if (best === null) return null;
  const cleaned = extractCleanText(best);
  return cleaned.length > 0 ? cleaned : null;
}

/** 容器缺少结构化标签列表时，从短文本节点里收集候选标签供经验/学历解析。 */
function splitContainerTagText(container: Element): string[] {
  const out: string[] = [];
  container.querySelectorAll('span, li, p, div').forEach((el) => {
    const text = el.textContent?.trim() ?? '';
    if (text.length > 0 && text.length <= 20) out.push(text);
  });
  return out;
}

export function extractBoss(url: string, doc: Document): BossExtraction {
  const layout = detectLayout(url, doc);
  // list_panel 走结构化「右侧详情容器」提取（§三/§四/§五），不与 job_detail 共用容器定位逻辑（§八）。
  if (layout === 'list_panel') {
    return extractListPanel(url, doc);
  }

  // 独立 job_detail：保留已通过真实验收的选择器路径（§八 回归保护），仅追加稳定身份。
  const sel = JOB_DETAIL_SELECTORS;
  const title = parseBossTitle(doc.querySelector('title')?.textContent ?? null);

  const role = extractRole(doc, sel, title.role);
  const cityFields = extractCity(doc, sel);
  const company = extractCompany(doc, sel, role.value, cityFields.address.value, title.company);
  const salary = parseSalary(firstText(doc, sel.salary));
  const tags = allTexts(doc, sel.tags);

  const experience = pickExperience(tags);
  const education = pickEducation(tags);
  const activityStatus = pickActivityStatus(doc);
  const identity = extractStableIdentity(url, 'job_detail');

  return {
    layout,
    role,
    company,
    city: cityFields.city,
    district: cityFields.district,
    address: cityFields.address,
    salaryMinK: salary.minK !== null ? known(salary.minK, 'boss_dom', 'high') : unknownField<number>('未识别薪资下限'),
    salaryMaxK: salary.maxK !== null ? known(salary.maxK, 'boss_dom', 'high') : unknownField<number>('未识别薪资上限'),
    salaryPeriod: salary.period !== null ? known(salary.period, 'boss_dom', 'high') : unknownField<string>('未识别薪资周期'),
    experienceRequirement: experience !== null ? known(experience, 'boss_dom', 'high') : unknownField<string>('未识别经验要求'),
    educationRequirement: education !== null ? known(education, 'boss_dom', 'high') : unknownField<string>('未识别学历要求'),
    activityStatus: activityStatus !== null ? known(activityStatus, 'boss_dom', 'high') : unknownField<string>('未识别招聘者活跃度'),
    jdText: extractJd(doc, sel),
    ...identity,
    blockingIssues: [],
    listPanelDiagnostics: null,
  };
}

/**
 * V8-2 批量采集：已知身份的右侧详情采集（§四/§五）。
 * 与 extractListPanel 的「自动猜测 selected 卡片」不同——身份锚点是用户亲自勾选的卡片，
 * 这里只负责：JD-first 定位右侧详情 → 严格校验它属于给定队列项 → 抽取右侧字段并与卡片字段合并。
 */
export interface KnownJobExpected {
  externalRecordId: string;
  providerKey: string;
  canonicalSourceUrl: string;
  roleFromCard: string | null;
  /** 归一化后的卡片薪资文本（用于交叉校验）。 */
  salaryFromCardNorm: string | null;
  /** 解析后的卡片薪资（右侧不可读时回退）。 */
  salaryFromCard: { minK: number | null; maxK: number | null; period: string | null } | null;
  salaryDecodedFromPua?: boolean;
  companyDisplayName: string | null;
  experienceFromCard: string | null;
  educationFromCard: string | null;
}

export type KnownJobStatus = 'captured' | 'needs_correction' | 'failed';

export interface KnownJobCapture {
  status: KnownJobStatus;
  identityMatch: boolean;
  identityBasis: 'right_panel_href' | 'role_salary_crosscheck' | 'none';
  rightPanelExternalRecordId: string | null;
  rightPanelRole: string | null;
  salaryCrossCheck: SalaryCrossCheck;
  blockingIssues: string[];
  role: FieldProvenance<string>;
  company: FieldProvenance<string>;
  /** 批量阶段仅取展示名；工商全称留到晋升/投递前补充（§五 两层公司）。 */
  companyLegalName: string | null;
  city: FieldProvenance<string>;
  district: FieldProvenance<string>;
  address: FieldProvenance<string>;
  salaryMinK: FieldProvenance<number>;
  salaryMaxK: FieldProvenance<number>;
  salaryPeriod: FieldProvenance<string>;
  experienceRequirement: FieldProvenance<string>;
  educationRequirement: FieldProvenance<string>;
  /** 采集瞬间的招聘者活跃状态，只写 extractionMetadata，不进入 recognizedFields。 */
  activityStatus: FieldProvenance<string>;
  jdText: string | null;
}

function knownJobLocateFailure(reason: string): KnownJobCapture {
  return {
    status: 'failed',
    identityMatch: false,
    identityBasis: 'none',
    rightPanelExternalRecordId: null,
    rightPanelRole: null,
    salaryCrossCheck: 'unavailable',
    blockingIssues: [reason],
    role: unknownField('未定位到右侧当前岗位详情头部，需人工确认'),
    company: unknownField('未定位到右侧当前岗位详情头部，需人工确认'),
    companyLegalName: null,
    city: unknownField('未识别城市'),
    district: unknownField('未识别区县'),
    address: unknownField('未识别详细地址'),
    salaryMinK: unknownField<number>('未识别薪资下限'),
    salaryMaxK: unknownField<number>('未识别薪资上限'),
    salaryPeriod: unknownField<string>('未识别薪资周期'),
    experienceRequirement: unknownField<string>('未识别经验要求'),
    educationRequirement: unknownField<string>('未识别学历要求'),
    activityStatus: unknownField<string>('未识别招聘者活跃度'),
    jdText: null,
  };
}

export function captureKnownJobFromRightPanel(doc: Document, expected: KnownJobExpected): KnownJobCapture {
  const located = locateRightPanel(doc);
  if (located.header === null) {
    return knownJobLocateFailure('未定位到右侧当前岗位详情头部，无法确认为所选岗位');
  }

  const header = located.header;
  const container = header.container;
  const rightPanelRole = header.role.value;
  const rightPanelSalaryNorm = header.headerSalaryReadable ? normalizeSalaryText(header.rawSalaryText) : null;
  const rightPanelExternalRecordId = uniqueJobIdWithin(container);
  const salaryCrossCheck = crossCheckSalary(rightPanelSalaryNorm, expected.salaryFromCardNorm);

  const blockingIssues: string[] = [];
  let identityMatch = false;
  let identityBasis: KnownJobCapture['identityBasis'] = 'none';

  if (rightPanelExternalRecordId !== null) {
    // 优先级 1：右侧详情自身 job_detail 链接与队列项一致（最强）。
    identityBasis = 'right_panel_href';
    identityMatch = rightPanelExternalRecordId === expected.externalRecordId;
    if (!identityMatch) {
      blockingIssues.push(`右侧详情 externalRecordId=${rightPanelExternalRecordId} 与所选岗位 ${expected.externalRecordId} 不一致`);
    }
  } else {
    // 优先级 2：右侧无可靠 ID → role 严格相等 +（两侧可读时）薪资严格相等。
    identityBasis = 'role_salary_crosscheck';
    const roleEqual = rightPanelRole !== null && expected.roleFromCard !== null
      && normalizeRoleTitle(rightPanelRole) === normalizeRoleTitle(expected.roleFromCard);
    if (!roleEqual) {
      blockingIssues.push('右侧详情无可靠 job_detail 链接，且 role 与所选卡片不一致，无法确认为同一岗位');
    } else if (salaryCrossCheck === 'mismatched') {
      blockingIssues.push('右侧详情无可靠 job_detail 链接，且两侧可读薪资不一致，无法确认为同一岗位');
    } else {
      identityMatch = true;
    }
  }

  const cityFields = extractCityWithin(container);
  const tags = allTexts(container, LIST_PANEL_CONTAINER_SELECTORS.tags);
  const tagPool = tags.length > 0 ? tags : splitContainerTagText(container);
  const panelExperience = pickExperience(tagPool);
  const panelEducation = pickEducation(tagPool);
  const panelActivityStatus = pickActivityStatus(container);
  const jd = extractJdWithin(container);

  // 薪资优先级（§五）：右侧头部可读 → 所选卡片可读 → null。
  const salaryFromHeader = header.salary.minK !== null;
  const salary = salaryFromHeader
    ? header.salary
    : (expected.salaryFromCard !== null && expected.salaryFromCard.minK !== null
      ? expected.salaryFromCard
      : { minK: null, maxK: null, period: null });
  const salaryDecodedFromPua = salaryFromHeader
    ? header.salaryDecodedFromPua
    : expected.salaryDecodedFromPua === true;
  const salarySource: FieldSource = salaryFromHeader ? 'boss_dom' : 'selected_card';
  const salaryConfidence: FieldConfidence = salaryDecodedFromPua ? 'medium' : 'high';
  const salaryUnknownIssue = salary.minK === null ? ['右侧与所选卡片薪资均不可读，请在预览中人工填写'] : [];

  // 公司：优先所选卡片展示名；卡片不可读时，在已通过岗位身份校验的右侧详情内复用既有受控公司抽取。
  // 不读取整页、不使用招聘者姓名、不从岗位标题猜公司；工商全称仍不在批量阶段持久化。
  let company: FieldProvenance<string>;
  if (expected.companyDisplayName !== null
    && isAcceptableCompany(expected.companyDisplayName, rightPanelRole, cityFields.address.value)) {
    company = known(expected.companyDisplayName, 'selected_card', 'high');
  } else if (identityMatch) {
    const trustedRightCompany = extractCompany(
      container, LIST_PANEL_CONTAINER_SELECTORS, rightPanelRole, cityFields.address.value, null,
    );
    company = trustedRightCompany.value !== null
      ? trustedRightCompany
      : (extractRecruiterAffiliationCompany(container, rightPanelRole, cityFields.address.value)
        ?? truncatedSelectedCompany(expected.companyDisplayName, rightPanelRole, cityFields.address.value)
        ?? unknownField('未识别完整公司名称，需要人工确认'));
  } else {
    company = unknownField('岗位身份未通过校验，不读取右侧公司');
  }

  const experienceValue = panelExperience ?? expected.experienceFromCard;
  const experience: FieldProvenance<string> = experienceValue !== null
    ? known(experienceValue, panelExperience !== null ? 'boss_dom' : 'selected_card', 'high')
    : unknownField<string>('未识别经验要求');
  const educationValue = panelEducation ?? expected.educationFromCard;
  const education: FieldProvenance<string> = educationValue !== null
    ? known(educationValue, panelEducation !== null ? 'boss_dom' : 'selected_card', 'high')
    : unknownField<string>('未识别学历要求');
  const activityStatus: FieldProvenance<string> = panelActivityStatus !== null
    ? known(panelActivityStatus, 'boss_dom', 'high')
    : unknownField<string>('未识别招聘者活跃度');

  // 状态裁决：身份不成立 → failed（阻塞）；href 身份成立但薪资冲突 → needs_correction（不阻塞，待人工）；否则 captured。
  let status: KnownJobStatus;
  const salaryFieldIssues = [...salaryUnknownIssue];
  const companyNeedsCorrection = identityMatch
    && (company.value === null || company.confidence !== 'high' || company.qualityIssues.length > 0);
  if (salaryDecodedFromPua) {
    salaryFieldIssues.push('薪资由 BOSS kanzhun PUA 字符映射得到，请人工确认');
  }
  if (!identityMatch) {
    status = 'failed';
  } else if (identityBasis === 'right_panel_href' && salaryCrossCheck === 'mismatched') {
    status = 'needs_correction';
    salaryFieldIssues.push('右侧与所选卡片薪资不一致，请确认后再写入');
  } else if (salaryDecodedFromPua || companyNeedsCorrection) {
    status = 'needs_correction';
  } else {
    status = 'captured';
  }

  const salaryMinK: FieldProvenance<number> = salary.minK !== null && status !== 'failed'
    ? known(salary.minK, salarySource, salaryConfidence, salaryFieldIssues.length > 0 && status === 'needs_correction' ? salaryFieldIssues : [])
    : { value: null, source: 'none', confidence: 'low', qualityIssues: salaryFieldIssues.length > 0 ? salaryFieldIssues : ['未识别薪资下限'] };
  const salaryMaxK: FieldProvenance<number> = salary.maxK !== null && status !== 'failed'
    ? known(salary.maxK, salarySource, salaryConfidence, salaryFieldIssues.length > 0 && status === 'needs_correction' ? salaryFieldIssues : [])
    : { value: null, source: 'none', confidence: 'low', qualityIssues: salaryFieldIssues.length > 0 ? salaryFieldIssues : ['未识别薪资上限'] };

  return {
    status,
    identityMatch,
    identityBasis,
    rightPanelExternalRecordId,
    rightPanelRole,
    salaryCrossCheck,
    blockingIssues,
    role: header.role,
    company,
    companyLegalName: null,
    city: cityFields.city,
    district: cityFields.district,
    address: cityFields.address,
    salaryMinK,
    salaryMaxK,
    salaryPeriod: salary.period !== null && status !== 'failed'
      ? known(salary.period, salarySource, salaryConfidence, salaryFieldIssues.length > 0 && status === 'needs_correction' ? salaryFieldIssues : [])
      : unknownField<string>('未识别薪资周期'),
    experienceRequirement: experience,
    educationRequirement: education,
    activityStatus,
    jdText: jd,
  };
}

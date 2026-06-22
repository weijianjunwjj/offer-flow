// 目标公司画像匹配度（纯函数，无副作用，不接 storage / 页面 / API）。
// 与「综合匹配度」「机会分」并列的第三项指标：判断当前 JD 是否符合「我的下一家公司目标画像」。
// 它不是预测模块，不做时间预测（offer 时间窗 / 面试推进等一律不在此处），只对静态 JD 打画像匹配分。
//
// 数据来源全部是 JobRecord 已持久化字段（城市 / JD / 公司补充 / 公司画像 / 薪资），
// 因此本指标按需「现算现展示」，不新增持久化字段、不改动两项已有指标、不需要数据迁移。
// 旧数据天然兼容：有内容就算分，完全空白则返回 null（页面显示「待评估」）。

import type { CompanyAssessment, CompanyInput, CompanySizeTier } from '../storage';

/** 第三项指标的计算结果（对应建议字段 score / level / reason） */
export interface TargetProfileScore {
  /** 目标公司画像匹配度，0-100 整数 */
  score: number;
  /** 等级文案 */
  level: string;
  /** 简短、可解释的评分原因 */
  reason: string;
}

/** 计算所需输入（JobRecord 的子集，便于解耦与自测） */
export interface TargetProfileInput {
  city: string;
  role: string;
  salaryRange: string;
  jdText: string;
  companyInput: CompanyInput;
  companyAssessment?: CompanyAssessment | null;
}

// ---------------------------------------------------------------------------
// 目标公司画像常量（来源：用户 2026-06-19 明确给出的画像，DEC-018）。
// ---------------------------------------------------------------------------

/** 苏州主战场核心加分板块 */
const SUZHOU_CORE_REGIONS = [
  '独墅湖',
  '园区南部',
  '工业园区',
  '园区',
  '斜塘',
  '桑田岛',
  '纳米科技园',
  '纳米',
  '尹山湖',
  '郭巷',
  '吴中东',
];

/** 杭州弱备选的重点区域 */
const HANGZHOU_CORE_REGIONS = ['滨江', '未来科技城', '余杭'];

/** 优先行业方向关键词 */
const POSITIVE_INDUSTRY = [
  '产业数字',
  '数据平台',
  '数据中台',
  '业务中台',
  '中台',
  '企业服务',
  'saas',
  '工业互联网',
  '供应链',
  '制造',
  '能源',
  '医疗',
  'b端',
  'b 端',
  '自研',
  '内部运营',
  '运营平台',
  '效率平台',
  '提效',
];

/** 明显降分行业 / 机会关键词 */
const NEGATIVE_INDUSTRY = ['外包', '驻场', '官网', '营销页', '活动页', '落地页', '切图'];

/** 优先岗位方向 / JD 关键词 */
const POSITIVE_ROLE = [
  '高级前端',
  '资深前端',
  '平台前端',
  '中后台',
  '工程化',
  '配置化',
  '低代码',
  '可视化',
  '权限',
  '审批流',
  '表格',
  '大模型',
  'ai应用',
  'ai 应用',
  'vue',
  'typescript',
  '前端架构',
];

/** 降分岗位关键词 */
const NEGATIVE_ROLE = ['切页面', '切图', '活动页', '官网', '营销页', '低复杂'];

// ---------------------------------------------------------------------------
// 解析辅助
// ---------------------------------------------------------------------------

/** 从文本中尽力解析「代表性月薪（单位 k）」；解析不到返回 null。 */
function parseMonthlyK(text: string): number | null {
  if (text.trim() === '') return null;
  const range = text.match(/(\d+(?:\.\d+)?)\s*[-~至到]\s*(\d+(?:\.\d+)?)\s*[kK]/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const single = text.match(/(\d+(?:\.\d+)?)\s*[kK]/);
  if (single) return Number(single[1]);
  return null;
}

/** 从文本中尽力解析「代表性人数」；解析不到返回 null。 */
function parseHeadcount(text: string): number | null {
  if (text.trim() === '') return null;
  const range = text.match(/(\d{2,6})\s*[-~至到]\s*(\d{2,6})\s*人/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;
  const single = text.match(/(\d{2,6})\s*人/);
  if (single) return Number(single[1]);
  return null;
}

/** 取「用户手填优先、AI 画像兜底」的公司规模档位 */
function effectiveSizeTier(input: TargetProfileInput): CompanySizeTier {
  if (input.companyInput.sizeTier !== 'unknown') {
    return input.companyInput.sizeTier;
  }
  return input.companyAssessment?.sizeTier ?? 'unknown';
}

interface DimScore {
  score: number;
  note: string;
}

// ---------------------------------------------------------------------------
// 各维度评分
// ---------------------------------------------------------------------------

/** 地理位置：满分 25 */
function scoreGeography(cityHay: string, regionHay: string): DimScore {
  const inSuzhou = cityHay.includes('苏州') || regionHay.includes('苏州');
  const suzhouCore = SUZHOU_CORE_REGIONS.some((k) => regionHay.includes(k));
  const inHangzhou = cityHay.includes('杭州') || regionHay.includes('杭州');
  const hangzhouCore = HANGZHOU_CORE_REGIONS.some((k) => regionHay.includes(k));

  if (suzhouCore) return { score: 25, note: '区域命中苏州核心板块（园区南部/独墅湖一带）' };
  if (inSuzhou) return { score: 20, note: '位于苏州主战场（非核心板块）' };
  if (hangzhouCore) return { score: 18, note: '杭州滨江/未来科技城（弱备选优质区）' };
  if (inHangzhou) return { score: 14, note: '杭州（非重点区域）' };
  if (cityHay.trim() !== '') return { score: 12, note: '非目标城市，按非核心区域中性处理' };
  return { score: 15, note: '区域信息不足，暂按中性计算' };
}

/** 公司规模：满分 15 */
function scoreSize(input: TargetProfileInput): DimScore {
  const head = parseHeadcount(
    `${input.companyInput.staffRange} ${input.jdText} ${input.companyInput.companyNote}`,
  );
  if (head !== null) {
    if (head >= 800 && head <= 1500) return { score: 15, note: '规模约 800-1500 人（核心命中）' };
    if (head >= 300 && head <= 2000) return { score: 13, note: '规模处于 300-2000 人优区' };
    if (head >= 100 && head < 300) return { score: 9, note: '规模 100-300 人（中性偏低）' };
    if (head >= 50 && head < 100) return { score: 7, note: '规模偏小（50-100 人）' };
    if (head >= 20 && head < 50) return { score: 5, note: '20-50 人小团队（明显降分）' };
    if (head < 20) return { score: 4, note: '过小创业团队（明显降分）' };
    return { score: 9, note: '超大型公司（中性，主导空间未必足）' };
  }
  switch (effectiveSizeTier(input)) {
    case 'large':
      return { score: 12, note: '规模大中厂（1000-9999，高分）' };
    case 'medium':
      return { score: 10, note: '规模中厂（100-999）' };
    case 'giant':
      return { score: 9, note: '超大型公司（中性）' };
    case 'small':
      return { score: 5, note: '小厂（20-99，明显降分）' };
    case 'micro':
      return { score: 4, note: '微型团队（明显降分）' };
    default:
      return { score: 9, note: '规模信息不足，暂按中性计算' };
  }
}

function countHits(hay: string, keywords: string[]): number {
  return keywords.reduce((n, k) => (hay.includes(k) ? n + 1 : n), 0);
}

/** 行业方向：满分 20 */
function scoreIndustry(hay: string): DimScore {
  const pos = countHits(hay, POSITIVE_INDUSTRY);
  const neg = countHits(hay, NEGATIVE_INDUSTRY);
  if (pos === 0 && neg > 0) return { score: 6, note: '行业偏外包/官网/营销页（降分）' };
  if (pos >= 2) return { score: 20, note: '行业为数据平台/企业服务/复杂 B 端方向' };
  if (pos === 1) return { score: 17, note: '行业方向偏目标画像' };
  return { score: 12, note: '行业信息不足，暂按中性计算' };
}

/** 岗位方向：满分 20 */
function scoreRole(hay: string): DimScore {
  const pos = countHits(hay, POSITIVE_ROLE);
  const neg = countHits(hay, NEGATIVE_ROLE);
  if (pos === 0 && neg > 0) return { score: 7, note: '岗位偏纯切页面/低复杂度（降分）' };
  if (pos >= 2) return { score: 20, note: '岗位涉及中后台/工程化/可视化等目标方向' };
  if (pos === 1) return { score: 16, note: '岗位方向偏目标画像' };
  return { score: 12, note: '岗位信息不足，暂按中性计算' };
}

type CityContext = 'suzhou' | 'hangzhou' | 'other';

/** 薪资画像：满分 10 */
function scoreSalary(salaryHay: string, cityContext: CityContext): DimScore {
  const k = parseMonthlyK(salaryHay);
  if (k === null) return { score: 6, note: '薪资信息不足，暂按中性计算' };
  if (cityContext === 'suzhou') {
    if (k >= 16 && k <= 18) return { score: 10, note: `薪资约 ${k}k 处于苏州 16-18k 核心区间` };
    if (k > 18) return { score: 8, note: `薪资约 ${k}k 高于苏州画像中枢` };
    if (k >= 14 && k < 16) return { score: 7, note: `薪资约 ${k}k 略低于苏州核心区间` };
    return { score: 4, note: `薪资约 ${k}k 低于苏州 14k（明显降分）` };
  }
  if (cityContext === 'hangzhou') {
    if (k >= 20) return { score: 9, note: `薪资约 ${k}k 满足杭州 20k+ 门槛` };
    return { score: 4, note: `薪资约 ${k}k 低于杭州 20k（迁移不划算）` };
  }
  return { score: 7, note: `薪资约 ${k}k（非主战场城市，中性处理）` };
}

/** 风险项扣分：最多扣 20 */
function scoreRiskDeduction(
  hay: string,
  input: TargetProfileInput,
  salaryK: number | null,
  cityContext: CityContext,
): DimScore {
  let deduction = 0;
  const reasons: string[] = [];

  if (hay.includes('外包') || hay.includes('驻场')) {
    deduction += 10;
    reasons.push('外包/驻场');
  }
  const pageOnly = ['切页面', '切图', '纯官网', '营销页', '活动页', '落地页'].some((k) =>
    hay.includes(k),
  );
  if (pageOnly) {
    deduction += 8;
    reasons.push('纯页面/官网/营销页');
  }
  if (hay.includes('画饼')) {
    deduction += 6;
    reasons.push('伪 AI 画饼');
  }

  const head = parseHeadcount(`${input.companyInput.staffRange} ${input.jdText}`);
  const tier = effectiveSizeTier(input);
  if ((head !== null && head >= 20 && head <= 50) || tier === 'small' || tier === 'micro') {
    deduction += 6;
    reasons.push('小作坊/前端职责过杂');
  }

  if (
    salaryK !== null &&
    ((cityContext === 'suzhou' && salaryK < 14) || (cityContext === 'hangzhou' && salaryK < 20))
  ) {
    deduction += 4;
    reasons.push('低薪');
  }

  deduction = Math.min(20, deduction);
  const note = reasons.length > 0 ? `命中风险项：${reasons.join('、')}（扣 ${deduction} 分）` : '';
  return { score: deduction, note };
}

// ---------------------------------------------------------------------------
// 等级文案与主入口
// ---------------------------------------------------------------------------

/** 画像匹配度等级文案（来源：用户给定阈值，DEC-018） */
export function getTargetProfileLevel(score: number): string {
  if (score >= 85) return '命中靶心';
  if (score >= 70) return '高度匹配';
  if (score >= 55) return '可以重点聊';
  if (score >= 40) return '谨慎观察';
  return '偏离画像';
}

/** 输入是否「完全空白」——没有任何可判断信息时返回 null → 页面显示「待评估」 */
function isBlank(input: TargetProfileInput): boolean {
  const ci = input.companyInput;
  const texts = [
    input.city,
    input.role,
    input.salaryRange,
    input.jdText,
    ci.staffRange,
    ci.companyType,
    ci.financingStage,
    ci.commuteWay,
    ci.companyNote,
    ci.opportunityNote,
  ];
  const hasText = texts.some((t) => t.trim() !== '');
  const hasTier = ci.sizeTier !== 'unknown' || (input.companyAssessment?.sizeTier ?? 'unknown') !== 'unknown';
  return !hasText && !hasTier;
}

/**
 * 计算目标公司画像匹配度。
 * - 完全空白输入 → null（页面显示「待评估」）
 * - 其余情况 → 0-100 整数 + 等级 + 简短原因，永不抛异常。
 */
export function calculateTargetProfileScore(
  input: TargetProfileInput,
): TargetProfileScore | null {
  if (isBlank(input)) {
    return null;
  }

  const ci = input.companyInput;
  const cityHay = input.city;
  const regionHay = [
    input.city,
    input.jdText,
    ci.companyNote,
    ci.opportunityNote,
    ci.commuteWay,
  ].join(' ');
  const industryHay = [input.jdText, ci.companyType, ci.companyNote, ci.opportunityNote]
    .join(' ')
    .toLowerCase();
  const roleHay = [input.role, input.jdText].join(' ').toLowerCase();
  const riskHay = [input.role, input.jdText, ci.companyType, ci.companyNote, ci.opportunityNote]
    .join(' ')
    .toLowerCase();
  const salaryHay = `${input.salaryRange} ${input.jdText}`;

  const cityContext: CityContext = regionHay.includes('苏州')
    ? 'suzhou'
    : regionHay.includes('杭州')
      ? 'hangzhou'
      : 'other';
  const salaryK = parseMonthlyK(salaryHay);

  const geo = scoreGeography(cityHay, regionHay);
  const size = scoreSize(input);
  const industry = scoreIndustry(industryHay);
  const role = scoreRole(roleHay);
  const salary = scoreSalary(salaryHay, cityContext);
  const risk = scoreRiskDeduction(riskHay, input, salaryK, cityContext);

  const raw = geo.score + size.score + industry.score + role.score + salary.score - risk.score;
  const score = Math.round(Math.min(100, Math.max(0, raw)));
  const level = getTargetProfileLevel(score);

  const notes = [geo.note, size.note, industry.note, role.note, salary.note];
  if (risk.note !== '') notes.push(risk.note);
  const reason = `${notes.join('，')}，故目标画像${level}。`;

  return { score, level, reason };
}

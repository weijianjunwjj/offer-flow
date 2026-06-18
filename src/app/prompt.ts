// Task 5：One-Shot 分析 Prompt 生成（纯函数，无副作用、不接任何 API）。
// 由全局配置 + 岗位基础信息 + 公司与机会补充（companyInput）拼接出 One-Shot Prompt，
// 要求外部 AI 一次性返回：①给人看的 Markdown 报告；②给机器解析的 OFFER_FLOW_JSON 数据块（DEC-016）。
// 本文件只生成 Prompt 文本，不做解析、不写结构化字段（解析见 Task 6/7）。
// 约束：输出中不得残留 {{}} 模板占位符（acceptance Task 4 #2）。
import type { JobSeekerProfile, JobSearchFocus, CompanyInput } from '../storage';
import { COMPANY_SIZE_LABELS } from './companyLabels';

export interface PromptJobInput {
  company: string;
  role: string;
  city: string;
  salaryRange: string;
  jdText: string;
}

const FOCUS_LABELS: Record<JobSearchFocus, string> = {
  stability: '求稳',
  raise: '涨薪',
  resume: '履历',
  growth: '技术成长',
};

const EMPTY = '（未填写）';

function text(value: string): string {
  return value.trim() === '' ? EMPTY : value.trim();
}

function bool(value: boolean): string {
  return value ? '是' : '否';
}

// OFFER_FLOW_JSON 示例：必须是合法、无注释的纯 JSON，供外部 AI 模仿结构。
// 枚举的「允许值」单独在 Prompt 文字里说明，避免在 JSON 内写注释。
const OFFER_FLOW_JSON_EXAMPLE = `---OFFER_FLOW_JSON_START---
{
  "version": "0.2.0",
  "matchScore": 82,
  "companyAssessment": {
    "sizeTier": "medium",
    "staffRange": "100-499人",
    "companyType": "自研业务",
    "financingStage": "未明确",
    "stabilityLevel": "medium",
    "growthPotential": "medium",
    "summary": "公司规模中等、自研业务为主，稳定性尚可，适合作为复杂中后台经验的延展机会。",
    "confidence": "medium"
  },
  "opportunityAnalysis": {
    "opportunityScore": 78,
    "opportunityRadar": {
      "salaryScore": 80,
      "stabilityScore": 72,
      "growthScore": 86,
      "matchScore": 82,
      "commuteScore": 70,
      "riskControlScore": 75
    },
    "applyAdvice": "ok",
    "riskLevel": "medium",
    "decisionSummary": "可以重点沟通，但需确认团队稳定性、加班强度与岗位核心程度。",
    "interviewFocus": [
      "准备复杂中后台治理案例",
      "强调 Vue3 + TypeScript 项目经验",
      "确认团队规模、业务稳定性与加班情况"
    ],
    "bossGreeting": "你好，我有 7 年 Vue 前端经验，长期负责复杂中后台与配置化页面，也做过 Vue3 + TS 项目。这个岗位如果偏业务系统或前端工程化，我比较匹配，想进一步了解一下。"
  }
}
---OFFER_FLOW_JSON_END---`;

/**
 * 由全局配置、岗位基础信息与公司补充信息生成 One-Shot Prompt。
 * profile / 各字段为空时以「（未填写）」兜底。
 */
export function buildAnalysisPrompt(
  profile: JobSeekerProfile | null,
  job: PromptJobInput,
  company: CompanyInput,
): string {
  const p = profile;
  const profileLines = [
    `- 简历正文：${text(p?.resumeText ?? '')}`,
    `- 项目经历：${text(p?.projectExperience ?? '')}`,
    `- 目标城市：${text(p?.targetCity ?? '')}`,
    `- 目标岗位方向：${text(p?.targetRole ?? '')}`,
    `- 期望薪资：${text(p?.expectedSalary ?? '')}`,
    `- 是否接受外包：${p ? bool(p.acceptOutsourcing) : EMPTY}`,
    `- 是否接受加班：${p ? bool(p.acceptOvertime) : EMPTY}`,
    `- 当前求职重点：${p ? FOCUS_LABELS[p.jobSearchFocus] : EMPTY}`,
    `- 个人短板：${text(p?.weaknessNote ?? '')}`,
  ].join('\n');

  const jobLines = [
    `- 公司名：${text(job.company)}`,
    `- 岗位名：${text(job.role)}`,
    `- 城市：${text(job.city)}`,
    `- 薪资范围：${text(job.salaryRange)}`,
    `- 岗位 JD：\n${text(job.jdText)}`,
  ].join('\n');

  const companyLines = [
    `- 公司规模：${COMPANY_SIZE_LABELS[company.sizeTier]}`,
    `- 人员规模原文：${text(company.staffRange)}`,
    `- 公司类型：${text(company.companyType)}`,
    `- 融资阶段：${text(company.financingStage)}`,
    `- 通勤时间：${text(company.commuteTime)}`,
    `- 通勤方式：${text(company.commuteWay)}`,
    `- 公司备注：${text(company.companyNote)}`,
    `- 机会备注：${text(company.opportunityNote)}`,
  ].join('\n');

  return [
    '你是一名资深的前端求职顾问，正在帮助一位使用 Boss 直聘找工作的前端开发者分析一个岗位机会。',
    '请根据下面的【求职者全局信息】【目标岗位信息】【公司与机会补充】，一次性输出两部分内容：',
    '第一部分是给人看的 Markdown 分析报告；第二部分是给机器解析的 OFFER_FLOW_JSON 数据块。',
    '',
    '【求职者全局信息】',
    profileLines,
    '',
    '【目标岗位信息】',
    jobLines,
    '',
    '【公司与机会补充】',
    companyLines,
    '',
    '====================',
    '第一部分：Markdown 分析报告（给人看）',
    '====================',
    '请先单独输出一行综合匹配度，格式固定为：综合匹配度：XX%',
    '（XX 为 0-100 的单一整数百分比，代表简历与岗位的综合匹配；不要写区间，难以精确时给一个代表值）',
    '随后用 Markdown 输出以下结构：',
    '1. 岗位类型判断',
    '2. 岗位关键词',
    '3. 技术栈匹配度',
    '4. 项目经验匹配度',
    '5. 优势命中',
    '6. 风险短板',
    '7. 简历优化建议',
    '8. 面试准备清单',
    '9. 投递建议（四选一：强烈建议沟通 / 可以沟通 / 谨慎沟通 / 不建议浪费精力，并简述理由）',
    '10. Boss 直聘打招呼话术（100 字以内，口语化，可直接发送给 HR）',
    '',
    '====================',
    '第二部分：OFFER_FLOW_JSON 数据块（给机器解析）',
    '====================',
    '在 Markdown 报告之后，另起一段，输出一个用固定标记包裹的 JSON 数据块，格式与示例完全一致：',
    '',
    OFFER_FLOW_JSON_EXAMPLE,
    '',
    '【字段允许值（必须严格使用下列英文代码，不要翻译成中文）】',
    '- companyAssessment.sizeTier：giant | large | medium | small | micro | unknown',
    '  （giant=大厂1万+，large=大中厂1000-9999，medium=中厂100-999，small=小厂20-99，micro=微厂0-20）',
    '- companyAssessment.stabilityLevel：high | medium | low | unknown',
    '- companyAssessment.growthPotential：high | medium | low | unknown',
    '- companyAssessment.confidence：high | medium | low',
    '- opportunityAnalysis.applyAdvice：strongly | ok | cautious | skip',
    '- opportunityAnalysis.riskLevel：low | medium | high | unknown',
    '- opportunityAnalysis.interviewFocus：字符串数组（2-5 条）',
    '- opportunityAnalysis.bossGreeting：字符串（与第一部分第 10 点话术一致即可）',
    '',
    '【硬性要求，必须遵守】',
    '1. 必须输出 ---OFFER_FLOW_JSON_START--- 与 ---OFFER_FLOW_JSON_END--- 两个标记，JSON 放在两者之间。',
    '2. 标记之间必须是合法 JSON，且不得包含任何注释（不要出现 // 或 /* */）。',
    '3. 所有分数字段（matchScore、opportunityScore、opportunityRadar 的 6 个维度）必须是 0-100 的整数。',
    '4. 枚举字段只能取上面列出的英文代码；信息不足时用 unknown（confidence 用 low），不要编造。',
    '5. 不知道、JD 未提及或无法判断的信息，请标低置信度（confidence/相关字段用 unknown 或 low），不要乱猜、不要硬编数字。',
    '6. companyAssessment 与 opportunityAnalysis 的字段结构必须稳定，键名、层级与示例保持一致，不要增删键。',
    '7. version 固定为 "0.2.0"。',
    '',
    '本工具不接入任何 AI API。请把以上内容整体复制给 ChatGPT / Claude / Gemini 等外部 AI，再把它返回的完整结果（含 Markdown 与 OFFER_FLOW_JSON）粘贴回工具。',
  ].join('\n');
}

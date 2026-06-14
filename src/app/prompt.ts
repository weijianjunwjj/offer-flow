// Task 4：分析 Prompt 生成（纯函数，无副作用、不接任何 API）。
// 由全局配置 + 岗位信息拼接出结构化 Prompt，供用户复制到外部 AI 使用。
// 约束：输出中不得残留 {{}} 模板占位符（acceptance Task 4 #2）。
import type { JobSeekerProfile, JobSearchFocus } from '../storage';

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

/** 由全局配置与岗位信息生成分析 Prompt。profile 为空时以「（未填写）」兜底。 */
export function buildAnalysisPrompt(
  profile: JobSeekerProfile | null,
  job: PromptJobInput,
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

  return [
    '你是一名资深的前端求职顾问，正在帮助一位使用 Boss 直聘找工作的前端开发者分析岗位。',
    '请根据下面的【求职者全局信息】和【目标岗位信息】，输出一份结构化的岗位匹配分析。',
    '',
    '【求职者全局信息】',
    profileLines,
    '',
    '【目标岗位信息】',
    jobLines,
    '',
    '【请严格按以下结构输出】',
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
  ].join('\n');
}

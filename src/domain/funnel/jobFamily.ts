export const JOB_FAMILIES = [
  'ai_applications',
  'fullstack_node',
  'data_platform_frontend',
  'frontend',
  'uncategorized',
] as const;
export type JobFamilyId = (typeof JOB_FAMILIES)[number];

export const JOB_FAMILY_LABELS: Record<JobFamilyId, string> = {
  ai_applications: 'AI 应用工程',
  fullstack_node: '全栈与 Node.js',
  data_platform_frontend: '数据平台与可视化前端',
  frontend: '前端开发',
  uncategorized: '其他 / 待归类',
};

interface JobFamilyRule {
  id: JobFamilyId;
  pattern: RegExp;
}

/**
 * 规则顺序即匹配优先级：越靠前越先命中。AI 规则必须排在前端规则之前，
 * 否则"AI 前端工程师"会被前端规则先截走，落入错误的岗位族。
 * 职级词汇（高级/资深/初级等）不参与匹配，因此"高级前端工程师"与
 * "前端工程师"归入同一岗位族。
 */
const RULES: readonly JobFamilyRule[] = [
  { id: 'ai_applications', pattern: /AI|Agent|LLM|RAG|智能体/i },
  { id: 'fullstack_node', pattern: /全栈|Node\.?js|NestJS|Fastify/i },
  { id: 'data_platform_frontend', pattern: /数据平台|BI|可视化|大屏|数据分析前端/i },
  { id: 'frontend', pattern: /前端|Vue|React|H5|小程序/i },
];

export function deriveJobFamily(role: string | null | undefined): JobFamilyId {
  const trimmed = role?.trim() ?? '';
  if (trimmed.length === 0) return 'uncategorized';
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return rule.id;
  }
  return 'uncategorized';
}

/**
 * V8-4 LLM 输入契约 `JobMatchAnalysisLlmInputV1`。
 *
 * 这是**模型可见层**：严禁任何内部数据库 ID（candidateId/candidateVersionId/
 * resumeVersionId/profileVersionId/assessmentId/sourceSnapshotId/taskId/AnalysisRecord ID 等），
 * 不含服务端 Envelope。只承载脱敏岗位事实、脱敏能力与约束、城市上下文、
 * 透明规则投影、证据目录、以及 prompt/contract 语义版本。
 *
 * 双层防护：Zod strictObject 保结构 + 递归安全扫描保内容/泄漏，二者不互相替代。
 */
import { z } from 'zod';
import { AnalysisContractError } from './contractErrors';
import { AnalysisEvidenceItemSchema } from './evidenceCatalog';
import { scanForbiddenContent, scanInternalIdLeak } from './safetyScan';

export const ANALYSIS_LLM_INPUT_CONTRACT_VERSION = 1;

const SHORT_TEXT = 200;
const MEDIUM_TEXT = 500;
const RAW_DESCRIPTION_MAX = 8_000;
const LIST_MAX = 100;
const bounded = (max: number) => z.string().max(max);

/** 脱敏岗位事实（无内部 ID）。 */
const LlmJobFactsSchema = z.strictObject({
  company: bounded(SHORT_TEXT).nullable(),
  role: bounded(SHORT_TEXT).nullable(),
  city: bounded(SHORT_TEXT).nullable(),
  salaryText: bounded(SHORT_TEXT).nullable(),
  experienceRequirement: bounded(SHORT_TEXT).nullable(),
  educationRequirement: bounded(SHORT_TEXT).nullable(),
  jobNature: bounded(SHORT_TEXT).nullable(),
  workMode: bounded(SHORT_TEXT).nullable(),
  technicalStack: z.array(bounded(SHORT_TEXT)).max(LIST_MAX),
  responsibilities: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  requirements: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  description: bounded(RAW_DESCRIPTION_MAX),
});

/** 脱敏个人能力与约束（无内部 ID）。 */
const LlmPersonProfileSchema = z.strictObject({
  capabilities: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  experienceHighlights: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  targetRoles: z.array(bounded(SHORT_TEXT)).max(LIST_MAX),
  coreCapabilities: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  constraints: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
  preferences: z.array(bounded(MEDIUM_TEXT)).max(LIST_MAX),
});

/** 透明规则投影（无 assessmentId）。 */
const LlmRuleProjectionItemSchema = z.strictObject({
  ruleKey: bounded(SHORT_TEXT),
  category: z.enum(['hard_constraint', 'risk', 'preference', 'state_suppression']),
  result: z.enum(['hit', 'pass', 'unknown']),
  severity: bounded(SHORT_TEXT),
  explanation: bounded(MEDIUM_TEXT),
});

export const JobMatchAnalysisLlmInputV1Schema = z.strictObject({
  contractVersion: z.literal(ANALYSIS_LLM_INPUT_CONTRACT_VERSION),
  promptVersion: z.string().min(1).max(80),
  jobFacts: LlmJobFactsSchema,
  person: LlmPersonProfileSchema,
  cityContext: z.strictObject({
    cityCode: bounded(SHORT_TEXT).nullable(),
    usesGlobalProfile: z.boolean(),
    missingCityEvidence: z.boolean(),
  }),
  ruleProjection: z.array(LlmRuleProjectionItemSchema).max(LIST_MAX),
  evidenceCatalog: z.array(AnalysisEvidenceItemSchema).max(LIST_MAX),
});
export type JobMatchAnalysisLlmInputV1 = z.infer<typeof JobMatchAnalysisLlmInputV1Schema>;

/**
 * 严格解析 LLM 输入：Zod strict → 内部 ID 泄漏扫描 → 敏感内容扫描。
 * 任一失败抛明确契约错误，绝不把带内部 ID 或敏感内容的输入发给模型。
 */
export function parseJobMatchAnalysisLlmInput(value: unknown): JobMatchAnalysisLlmInputV1 {
  const result = JobMatchAnalysisLlmInputV1Schema.safeParse(value);
  if (!result.success) {
    throw new AnalysisContractError('LLM_INPUT_INVALID', 'LLM 输入未通过契约校验', result.error.issues[0]?.path.join('.'));
  }
  const idLeak = scanInternalIdLeak(result.data);
  if (idLeak.length > 0) {
    throw new AnalysisContractError('LLM_INPUT_INTERNAL_ID_LEAK', 'LLM 输入包含内部数据库 ID', idLeak[0]?.path);
  }
  const forbidden = scanForbiddenContent(result.data);
  if (forbidden.length > 0) {
    throw new AnalysisContractError('LLM_INPUT_SENSITIVE_CONTENT', 'LLM 输入包含敏感内容（凭证/HTML/路径等）', forbidden[0]?.path);
  }
  return result.data;
}

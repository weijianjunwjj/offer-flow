import type { FastifyInstance, FastifyReply } from 'fastify';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import type { JobSeekerProfile } from '../../src/storage';
import {
  JobMatchProfileDraftSchema,
  activateJobMatchProfileVersion,
  addJobMatchProfileProposal,
  createEmptyJobMatchProfileState,
  createManualJobMatchProfileDraft,
  decideJobMatchProfileProposal,
  parseJobMatchProfileState,
  type JobMatchProfileDraft,
  type JobMatchProfileSeed,
  type JobMatchProfileState,
} from '../../src/domain/job-match-profile';
import { chatCompletion, getMissingLlmConfigFields, isLlmConfigured } from '../llm/provider';
import { JobRepository } from '../repositories/jobRepository';
import { ProfileRepository } from '../repositories/profileRepository';

interface ExtendedProfile extends JobSeekerProfile {
  jobMatchProfileState?: unknown;
}

const ManualProposalRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
  draft: JobMatchProfileDraftSchema.optional(),
});

const AiProposalRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
});

const ProposalDecisionRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
  action: z.enum(['accept', 'modify_and_accept', 'reject', 'defer']),
  note: z.string().optional(),
  deferredUntil: z.number().int().nonnegative().nullable().optional(),
  modifiedDraft: JobMatchProfileDraftSchema.optional(),
});

const ActivateVersionRequestSchema = z.strictObject({
  expectedStateVersion: z.number().int().nonnegative(),
});

const AI_PROMPT_VERSION = 'job-match-profile-g1-v1';
const AI_SYSTEM_PROMPT = `你是 OfferFlow 的岗位匹配画像提案生成器。
只输出一个 JSON 对象，不要 Markdown、代码围栏或解释。
你只能生成待用户审核的 proposal 草案，不能宣称已经形成正式能力基线、正式市场画像或正式降薪/降级结论。

必须满足：
1. schemaVersion 固定为 1。
2. 必须包含 global、suzhou、wuxi、shanghai、hangzhou 五个视图，scope 必须分别匹配。
3. 每个视图都要包含核心定位、最高可达岗位、冲刺/主攻/稳妥、优势、待验证能力、限制、理想环境、可接受范围、支持证据、反证、最大不确定性、置信状态和 blockedConclusions。
4. 城市之间不得混算薪资、供给、转化、学历门槛、公司偏好和渠道表现。跨城能力证据只能显式借用，并填写 borrowed、borrowingReason、sourceCity、weight 和 notApplicableTo。
5. 样本不足时 confidenceState 使用 insufficient 或 exploratory，并明确禁止正式降薪、降级或下调长期定位。
6. supportEvidence 与 counterEvidence 中每项必须包含 id、statement、sourceType、sourceLabel、sourceCity、polarity、weight、borrowed、borrowingReason、notApplicableTo。
7. 所有数组可以短，但不能省略字段；所有必填字符串必须非空。`;

function emptyProfile(): ExtendedProfile {
  return {
    resumeText: '',
    projectExperience: '',
    targetCity: '',
    targetRole: '',
    expectedSalary: '',
    acceptOutsourcing: false,
    acceptOvertime: false,
    jobSearchFocus: 'stability',
    weaknessNote: '',
  };
}

function loadContext(app: FastifyInstance): {
  repo: ProfileRepository;
  profile: ExtendedProfile;
  state: JobMatchProfileState;
} {
  const repo = new ProfileRepository(app.db);
  const profile = (repo.get() as ExtendedProfile | null) ?? emptyProfile();
  const state = profile.jobMatchProfileState === undefined
    ? createEmptyJobMatchProfileState()
    : parseJobMatchProfileState(profile.jobMatchProfileState);
  return { repo, profile, state };
}

function saveState(
  repo: ProfileRepository,
  profile: ExtendedProfile,
  state: JobMatchProfileState,
): JobMatchProfileState {
  repo.save({ ...profile, jobMatchProfileState: state } as JobSeekerProfile);
  return state;
}

function seedFromProfile(profile: ExtendedProfile): JobMatchProfileSeed {
  return {
    resumeText: profile.resumeText ?? '',
    projectExperience: profile.projectExperience ?? '',
    targetCity: profile.targetCity ?? '',
    targetRole: profile.targetRole ?? '',
    expectedSalary: profile.expectedSalary ?? '',
    weaknessNote: profile.weaknessNote ?? '',
  };
}

function validateStateVersion(
  state: JobMatchProfileState,
  expected: number,
  reply: FastifyReply,
): boolean {
  if (state.stateVersion === expected) return true;
  void reply.code(409).send({
    code: 'JOB_MATCH_PROFILE_STATE_CONFLICT',
    message: '岗位画像状态已变化，请刷新后重试',
    currentStateVersion: state.stateVersion,
  });
  return false;
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 返回内容中没有完整 JSON 对象');
  return JSON.parse(withoutFence.slice(start, end + 1));
}

function assertViewScopes(draft: JobMatchProfileDraft): void {
  const expected = {
    global: 'global',
    suzhou: 'suzhou',
    wuxi: 'wuxi',
    shanghai: 'shanghai',
    hangzhou: 'hangzhou',
  } as const;
  for (const [key, scope] of Object.entries(expected)) {
    if (draft[key as keyof typeof expected].scope !== scope) {
      throw new Error(`${key} 视图 scope 必须为 ${scope}`);
    }
  }
}

function buildAiUserPrompt(app: FastifyInstance, profile: ExtendedProfile): string {
  const jobs = new JobRepository(app.db).list().map((job) => ({
    id: job.id,
    company: job.company,
    role: job.role,
    city: job.city,
    salaryRange: job.salaryRange,
    matchScore: job.matchScore,
    reportStrengths: job.report?.strengths ?? '',
    reportRisks: job.report?.risks ?? '',
  }));
  return JSON.stringify({
    task: '生成 G1 全局岗位匹配画像 proposal 草案',
    profile: {
      resumeText: profile.resumeText,
      projectExperience: profile.projectExperience,
      targetCity: profile.targetCity,
      targetRole: profile.targetRole,
      expectedSalary: profile.expectedSalary,
      acceptOutsourcing: profile.acceptOutsourcing,
      acceptOvertime: profile.acceptOvertime,
      jobSearchFocus: profile.jobSearchFocus,
      weaknessNote: profile.weaknessNote,
    },
    jobSamples: jobs,
    outputContract: {
      schemaVersion: 1,
      requiredViews: ['global', 'suzhou', 'wuxi', 'shanghai', 'hangzhou'],
      confidenceStates: ['insufficient', 'exploratory', 'actionable'],
      bandLabels: ['stretch', 'focus', 'safe'],
    },
  });
}

function sendValidationError(reply: FastifyReply, error: unknown): void {
  void reply.code(400).send({
    code: 'JOB_MATCH_PROFILE_VALIDATION_ERROR',
    message: error instanceof Error ? error.message : '岗位画像请求不合法',
  });
}

export function registerJobMatchProfileRoutes(app: FastifyInstance): void {
  app.get('/job-match-profile', async () => loadContext(app).state);

  app.post('/job-match-profile/proposals/manual', async (request, reply) => {
    const parsed = ManualProposalRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const { repo, profile, state } = loadContext(app);
    if (!validateStateVersion(state, parsed.data.expectedStateVersion, reply)) return;
    try {
      const draft = parsed.data.draft ?? createManualJobMatchProfileDraft(seedFromProfile(profile));
      assertViewScopes(draft);
      const result = addJobMatchProfileProposal(state, {
        id: `jmp_${nanoid(12)}`,
        source: 'manual',
        draft,
        createdAt: Date.now(),
      });
      return saveState(repo, profile, result.state);
    } catch (error) {
      return sendValidationError(reply, error);
    }
  });

  app.post('/job-match-profile/proposals/ai', async (request, reply) => {
    const parsed = AiProposalRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const { repo, profile, state } = loadContext(app);
    if (!validateStateVersion(state, parsed.data.expectedStateVersion, reply)) return;
    if (!isLlmConfigured()) {
      return reply.code(400).send({
        code: 'LLM_NOT_CONFIGURED',
        message: `LLM 未配置：缺少 ${getMissingLlmConfigFields().join(', ')}`,
      });
    }
    const createdAt = Date.now();
    const llmResult = await chatCompletion(
      AI_SYSTEM_PROMPT,
      buildAiUserPrompt(app, profile),
      { maxTokens: 4096, temperature: 0.1, timeoutMs: 60000 },
    );
    if (llmResult.error) {
      return reply.code(502).send({
        code: 'JOB_MATCH_PROFILE_AI_ERROR',
        message: llmResult.error,
      });
    }
    try {
      const draft = JobMatchProfileDraftSchema.parse(extractJsonObject(llmResult.rawText));
      assertViewScopes(draft);
      const result = addJobMatchProfileProposal(state, {
        id: `jmp_${nanoid(12)}`,
        source: 'ai',
        draft,
        createdAt,
        aiRun: {
          model: llmResult.model,
          promptVersion: AI_PROMPT_VERSION,
          rawText: llmResult.rawText,
          createdAt,
        },
      });
      return saveState(repo, profile, result.state);
    } catch (error) {
      return reply.code(422).send({
        code: 'JOB_MATCH_PROFILE_AI_INVALID_DRAFT',
        message: error instanceof Error ? error.message : 'AI 返回的岗位画像草案不符合严格结构',
      });
    }
  });

  app.post('/job-match-profile/proposals/:proposalId/decision', async (request, reply) => {
    const parsed = ProposalDecisionRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const { proposalId } = request.params as { proposalId: string };
    const { repo, profile, state } = loadContext(app);
    if (!validateStateVersion(state, parsed.data.expectedStateVersion, reply)) return;
    try {
      const next = decideJobMatchProfileProposal(state, {
        proposalId,
        action: parsed.data.action,
        now: Date.now(),
        versionId: parsed.data.action === 'accept' || parsed.data.action === 'modify_and_accept'
          ? `jmpv_${nanoid(12)}`
          : undefined,
        modifiedDraft: parsed.data.modifiedDraft,
        note: parsed.data.note,
        deferredUntil: parsed.data.deferredUntil,
      });
      return saveState(repo, profile, next);
    } catch (error) {
      return sendValidationError(reply, error);
    }
  });

  app.post('/job-match-profile/versions/:versionId/activate', async (request, reply) => {
    const parsed = ActivateVersionRequestSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    const { versionId } = request.params as { versionId: string };
    const { repo, profile, state } = loadContext(app);
    if (!validateStateVersion(state, parsed.data.expectedStateVersion, reply)) return;
    try {
      const next = activateJobMatchProfileVersion(state, versionId, Date.now());
      return saveState(repo, profile, next);
    } catch (error) {
      return sendValidationError(reply, error);
    }
  });
}

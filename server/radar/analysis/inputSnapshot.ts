/**
 * V8-4 单岗位分析 · 服务端输入快照组装（从真实正式数据读取，本波次不调用模型）。
 *
 * 读取：目标候选版本（radar）、当前正式简历版本、正式求职画像版本，
 * 以及可选的能力基线 / 市场位置 / 求职策略正式版本；关闭 NovaWing Context 时继续组装 V1，
 * 开启时显式组装 V2，并计算确定性 inputHash 与 taskId。规则投影按 schema v7/v8 兼容读取 evidence_json，
 * 覆盖态复用 ruleOverrideProjection 权威算法；缺失能力/市场/策略仅在 readiness 记录局限。
 */
import { sha256RequestHash } from '../../job-memory/requestHash';
import type { SqliteDatabase } from '../../db';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarActionRepository } from '../actionRepository';
import { ResumeVersionRepository } from '../../job-memory/resumeVersionRepository';
import { ProfileRepository } from '../../repositories/profileRepository';
import { CapabilityBaselineRepository } from '../../capability-baseline/repository';
import { MarketPositionRepository } from '../../market-position/repository';
import { StrategyRepository } from '../../strategy-window/repository';
import { parseRuleEvidenceJson } from '../ruleEvidenceContract';
import { currentOverrideState, overrideStateToProjection } from '../ruleOverrideProjection';
import { normalizeJobMatchCity } from '../../job-match-profile/inputSnapshot';
import {
  ANALYSIS_INPUT_SNAPSHOT_CONTRACT_VERSION_V1,
  ANALYSIS_INPUT_SNAPSHOT_CONTRACT_VERSION_V2,
  parseJobMatchAnalysisInputSnapshot,
  type JobMatchAnalysisInputSnapshot,
  type JobMatchAnalysisInputSnapshotV1,
} from './contracts';
import { buildJobMatchAnalysisInputHash, buildJobMatchAnalysisTaskId } from './inputHash';
import { AnalysisInputError } from './inputErrors';
import type { FrozenNovaWingAnalysisContext } from './novaWingContext';

/** 组装选项：本波次不调用 Provider，版本/Provider 元数据由调用方注入（执行波次消费）。 */
export interface BuildAnalysisInputSnapshotOptions {
  promptVersion: string;
  analysisPolicyVersion: string;
  providerPolicyVersion: string;
  provider: { providerName: string; modelName: string; modelVersion: string | null };
  /** Omitted when the feature is disabled, preserving the original V1 snapshot byte semantics. */
  novaWingContext?: FrozenNovaWingAnalysisContext;
  now?: () => number;
}

export interface BuildAnalysisInputSnapshotResult {
  snapshot: JobMatchAnalysisInputSnapshot;
  inputHash: string;
  taskId: string;
}

const SHORT = 200;
const MEDIUM = 500;
const TEXT = 8_000;
const clamp = (value: string, max: number): string => value.slice(0, max);
const CITY_LABELS: Record<string, string> = { suzhou: '苏州', wuxi: '无锡', shanghai: '上海', hangzhou: '杭州' };

interface AssessmentRow {
  id: string; rule_version: string; rule_key: string;
  category: 'hard_constraint' | 'risk' | 'preference' | 'state_suppression';
  severity: string; result: 'hit' | 'pass' | 'unknown';
  explanation: string; evidence_json: string | null;
}

/** evidence_json 列在 v7 不存在、v8 才新增：按列存在性构造兼容 SELECT，绝不假设列必然存在。 */
function hasEvidenceJsonColumn(db: SqliteDatabase): boolean {
  const cols = db.prepare('PRAGMA table_info(radar_rule_assessments)').all() as Array<{ name: string }>;
  return cols.some((col) => col.name === 'evidence_json');
}

function readAssessments(db: SqliteDatabase, candidateVersionId: string): AssessmentRow[] {
  const evidenceCol = hasEvidenceJsonColumn(db) ? 'evidence_json' : 'NULL AS evidence_json';
  return db
    .prepare(
      `SELECT id, rule_version, rule_key, category, severity, result, explanation, ${evidenceCol}
       FROM radar_rule_assessments WHERE candidate_version_id = ? ORDER BY created_at, id`,
    )
    .all(candidateVersionId) as AssessmentRow[];
}

/** evidence_json 载体状态：NULL→legacy_scalar；合法→structured；非 NULL 但校验失败→corrupt（明确标记）。 */
function classifyEvidence(evidenceJson: string | null): 'structured' | 'legacy_scalar' | 'corrupt' {
  if (evidenceJson === null) return 'legacy_scalar';
  return parseRuleEvidenceJson(evidenceJson).status === 'valid' ? 'structured' : 'corrupt';
}

/** 从「state.activeVersionId + versions[]」结构取当前正式版本（四个版本化领域同构）。 */
function activeVersionOf<V extends { id: string }>(
  state: { activeVersionId: string | null; versions: V[] } | null | undefined,
): V | null {
  if (state?.activeVersionId == null) return null;
  return state.versions.find((version) => version.id === state.activeVersionId) ?? null;
}

/** 稳定截断 + 限量：先 map 投影再取前 LIST_MAX 条，保证同输入同输出。 */
function boundedList(items: readonly string[], max: number, limit = 60): string[] {
  return items.map((item) => clamp(item, max)).filter((item) => item.trim() !== '').slice(0, limit);
}

/** 领域版本无独立 contentHash 时，用 canonical 投影的 sha256 作为稳定内容指纹。 */
function contentHashOf(safeSnapshot: unknown): string {
  return sha256RequestHash(safeSnapshot);
}

type ProfileSafe = JobMatchAnalysisInputSnapshotV1['jobMatchProfile']['safeSnapshot'];
type CapabilitySafe = NonNullable<JobMatchAnalysisInputSnapshotV1['capabilityBaseline']>['safeSnapshot'];
type MarketSafe = NonNullable<JobMatchAnalysisInputSnapshotV1['marketPosition']>['safeSnapshot'];
type StrategySafe = NonNullable<JobMatchAnalysisInputSnapshotV1['strategy']>['safeSnapshot'];

/* eslint-disable @typescript-eslint/no-explicit-any -- 领域 draft 结构在各自领域已强类型，这里只做保守脱敏投影。 */
function projectProfile(draft: any): ProfileSafe {
  return {
    targetRoles: boundedList(draft.primaryRoleFamilies ?? [], SHORT),
    coreCapabilities: boundedList((draft.coreCapabilities ?? []).map((c: any) => `${c.label}：${c.summary}`), MEDIUM),
    constraints: boundedList((draft.constraints ?? []).map((c: any) => `${c.label}：${c.summary}`), MEDIUM),
    preferences: boundedList([draft.idealEnvironment?.description ?? '', ...(draft.acceptableRange?.notes ?? [])], MEDIUM),
  };
}

function projectCapability(draft: any): CapabilitySafe {
  const strong = new Set(['established', 'supported']);
  const caps: any[] = draft.capabilities ?? [];
  return {
    strengths: boundedList(caps.filter((c) => strong.has(c.conclusionStatus)).map((c) => `${c.label}：${c.conclusion}`), MEDIUM),
    gaps: boundedList(caps.filter((c) => !strong.has(c.conclusionStatus)).map((c) => `${c.label}：${c.largestUncertainty || c.conclusion}`), MEDIUM),
  };
}

function projectMarket(draft: any): MarketSafe {
  const global = draft.global ?? {};
  return {
    positioning: global.positioning ? clamp(global.positioning, MEDIUM) : null,
    competitiveFactors: boundedList([...(global.observedStrengths ?? []), ...(global.marketSignals ?? [])], MEDIUM),
  };
}

function projectStrategy(version: any): StrategySafe {
  const payload = version.payload ?? {};
  return {
    focus: payload.objective ? clamp(payload.objective, MEDIUM) : (payload.headline ? clamp(payload.headline, MEDIUM) : null),
    tactics: boundedList((payload.actions ?? []).map((a: any) => `${a.title}：${a.rationale}`), MEDIUM),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * 组装并校验单岗位分析输入快照。
 * 严格前置：候选版本须存在且候选处于 active；须有正式简历与正式画像版本；岗位事实须足以分析。
 * 缺失能力/市场/策略不阻断，仅在 readiness 记录局限（confidenceCeiling / limitations）。
 */
export function buildJobMatchAnalysisInputSnapshot(
  db: SqliteDatabase,
  candidateVersionId: string,
  options: BuildAnalysisInputSnapshotOptions,
): BuildAnalysisInputSnapshotResult {
  const candidates = new RadarCandidateRepository(db);
  const version = candidates.getVersion(candidateVersionId);
  if (version === null) {
    throw new AnalysisInputError('CANDIDATE_VERSION_NOT_FOUND', '目标候选版本不存在', 'candidateVersionId');
  }
  const candidate = candidates.getCandidate(version.candidateId);
  if (candidate === null) {
    throw new AnalysisInputError('CANDIDATE_NOT_FOUND', '候选不存在', 'candidateId');
  }
  if (candidate.lifecycleStatus !== 'active') {
    throw new AnalysisInputError('CANDIDATE_NOT_ANALYZABLE', `候选生命周期为 ${candidate.lifecycleStatus}，不可分析`);
  }
  if (candidate.activeVersionId !== candidateVersionId) {
    // 只分析候选当前正式版本，避免对已被取代的旧版本产生结论。
    throw new AnalysisInputError('CANDIDATE_VERSION_MISMATCH', '目标版本不是候选当前正式版本');
  }

  const resumeRepo = new ResumeVersionRepository(db);
  const activeResumeId = resumeRepo.getActiveResumeVersionId();
  const resume = activeResumeId === null ? null : resumeRepo.getResumeVersion(activeResumeId);
  if (resume === null) {
    throw new AnalysisInputError('ACTIVE_RESUME_REQUIRED', '缺少当前正式简历版本');
  }

  const profile = new ProfileRepository(db).get();
  const profileVersion = activeVersionOf(profile?.jobMatchProfile);
  if (profileVersion === null) {
    throw new AnalysisInputError('ACTIVE_PROFILE_REQUIRED', '缺少当前正式求职画像版本');
  }

  const n = version.normalized;
  const hasCoreFacts = [n.role, n.company, n.rawDescription.trim()].some((v) => v !== null && v !== '')
    || n.responsibilities.length > 0 || n.requirements.length > 0 || n.technicalStack.length > 0;
  if (!hasCoreFacts) {
    throw new AnalysisInputError('INPUT_NOT_READY', '岗位标准化事实不足以支撑分析（缺少角色/公司/描述/职责/要求）');
  }

  const snapshot = assembleSnapshot(db, { version, resume, profileVersion, options });
  const parsed = parseJobMatchAnalysisInputSnapshot(snapshot);
  const inputHash = buildJobMatchAnalysisInputHash(parsed);
  return { snapshot: parsed, inputHash, taskId: buildJobMatchAnalysisTaskId(inputHash) };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- 领域 draft 已在各自领域强类型，此处仅脱敏投影。 */
interface AssembleInput {
  version: ReturnType<RadarCandidateRepository['getVersion']> & object;
  resume: NonNullable<ReturnType<ResumeVersionRepository['getResumeVersion']>>;
  profileVersion: any;
  options: BuildAnalysisInputSnapshotOptions;
}

function assembleSnapshot(db: SqliteDatabase, input: AssembleInput): JobMatchAnalysisInputSnapshot {
  const { version, resume, profileVersion, options } = input;
  const now = options.now ?? Date.now;
  const n = version!.normalized;

  const capVersion = activeVersionOf(new CapabilityBaselineRepository(db).getState());
  const marketVersion = activeVersionOf(new MarketPositionRepository(db).getState());
  const strategyVersion = activeVersionOf(new StrategyRepository(db).getState());

  const rows = readAssessments(db, version!.id);
  const actionsDesc = new RadarActionRepository(db).listByCandidate(version!.candidateId);
  const assessments = rows.map((row) => ({
    ruleKey: clamp(row.rule_key, SHORT), category: row.category, result: row.result,
    severity: clamp(row.severity, SHORT), explanation: clamp(row.explanation, MEDIUM),
    evidenceState: classifyEvidence(row.evidence_json),
  }));
  const userOverrides = rows.flatMap((row) => {
    const projection = overrideStateToProjection(currentOverrideState(actionsDesc, row.id));
    return projection === null ? [] : [{ ruleKey: clamp(row.rule_key, SHORT), overrideState: projection, note: null }];
  });
  const ruleVersions = [...new Set(rows.map((row) => row.rule_version))].sort();
  const ruleProjection = {
    version: clamp(ruleVersions.join(',') || 'none', 80),
    projectionHash: sha256RequestHash({ candidateVersionId: version!.id, assessments, userOverrides }),
    assessments, userOverrides,
  };

  const cityCode = normalizeJobMatchCity(n.city);
  const cityContext = {
    cityCode: cityCode === null ? null : CITY_LABELS[cityCode] ?? cityCode,
    usesGlobalProfile: cityCode === null,
    missingCityEvidence: cityCode === null,
  };

  const limitations: string[] = [];
  if (capVersion === null) limitations.push('缺少能力基线正式版本：结论置信度上限为 medium');
  if (marketVersion === null) limitations.push('缺少市场位置正式版本：不能形成强市场结论');
  if (strategyVersion === null) limitations.push('缺少求职策略正式版本：不能形成强策略结论');
  if (cityCode === null) limitations.push('岗位城市不在目标城市集合：回退全局画像，城市证据缺失');
  const readiness = {
    hasCapabilityBaseline: capVersion !== null,
    hasMarketPosition: marketVersion !== null,
    hasStrategy: strategyVersion !== null,
    confidenceCeiling: (capVersion === null ? 'medium' : 'high') as 'low' | 'medium' | 'high',
    limitations: limitations.slice(0, 60),
  };

  const resumeSafe = {
    name: resume.name === '' ? null : clamp(resume.name, SHORT),
    summary: resume.summary === '' ? null : clamp(resume.summary, MEDIUM),
    resumeText: clamp(resume.contentSnapshot.resumeText, TEXT),
    projectExperience: clamp(resume.contentSnapshot.projectExperience, TEXT),
  };
  const profileSafe = projectProfile(profileVersion);
  const capSafe = capVersion === null ? null : projectCapability(capVersion);
  const marketSafe = marketVersion === null ? null : projectMarket(marketVersion);
  const strategySafe = strategyVersion === null ? null : projectStrategy(strategyVersion);

  const common: Omit<JobMatchAnalysisInputSnapshotV1, 'contractVersion'> = {
    candidate: {
      candidateId: version!.candidateId, candidateVersionId: version!.id, contentHash: version!.contentHash,
      normalizedFacts: {
        company: nullableClamp(n.company, SHORT), role: nullableClamp(n.role, SHORT), city: nullableClamp(n.city, SHORT),
        district: nullableClamp(n.district, SHORT), salaryMinK: n.salaryMinK, salaryMaxK: n.salaryMaxK,
        salaryPeriod: nullableClamp(n.salaryPeriod, SHORT), experienceRequirement: nullableClamp(n.experienceRequirement, SHORT),
        educationRequirement: nullableClamp(n.educationRequirement, SHORT), companySize: nullableClamp(n.companySize, SHORT),
        industry: nullableClamp(n.industry, SHORT), jobNature: nullableClamp(n.jobNature, SHORT),
        workMode: nullableClamp(n.workMode, SHORT), technicalStack: boundedList(n.technicalStack, SHORT),
        responsibilities: boundedList(n.responsibilities, MEDIUM), requirements: boundedList(n.requirements, MEDIUM),
        publishedAt: n.publishedAt, rawDescription: clamp(n.rawDescription, TEXT),
      },
      qualityIssues: version!.qualityIssues.map((q) => ({ field: clamp(q.field, SHORT), issue: clamp(q.issue, MEDIUM) })).slice(0, 60),
      sourceSnapshotIds: [...new Set(version!.sourceSnapshotIds)].slice(0, 60),
    },
    resume: { versionId: resume.id, contentHash: resume.contentHash, safeSnapshot: resumeSafe },
    jobMatchProfile: { versionId: profileVersion.id, contentHash: contentHashOf(profileSafe), safeSnapshot: profileSafe },
    capabilityBaseline: capSafe === null ? null : { versionId: capVersion!.id, contentHash: contentHashOf(capSafe), safeSnapshot: capSafe },
    marketPosition: marketSafe === null ? null : { versionId: marketVersion!.id, contentHash: contentHashOf(marketSafe), safeSnapshot: marketSafe },
    strategy: strategySafe === null ? null : { versionId: strategyVersion!.id, contentHash: contentHashOf(strategySafe), safeSnapshot: strategySafe },
    cityContext, readiness, ruleProjection,
    promptVersion: options.promptVersion, analysisPolicyVersion: options.analysisPolicyVersion,
    providerPolicyVersion: options.providerPolicyVersion, provider: options.provider,
    createdAt: now(),
  };
  if (options.novaWingContext === undefined) {
    return { contractVersion: ANALYSIS_INPUT_SNAPSHOT_CONTRACT_VERSION_V1, ...common };
  }
  return {
    contractVersion: ANALYSIS_INPUT_SNAPSHOT_CONTRACT_VERSION_V2,
    ...common,
    novaWingContext: {
      coreRevision: options.novaWingContext.coreRevision,
      scopes: [...options.novaWingContext.scopes] as ['global', 'career'],
      entries: options.novaWingContext.entries.map((entry) => ({ ...entry })),
    },
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const nullableClamp = (value: string | null, max: number): string | null => (value === null ? null : clamp(value, max));

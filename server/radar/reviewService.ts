/**
 * V8-3 人工评审工作台的只读组装 + 写操作协调（Wave 6）。
 *
 * 只读：候选决策详情 / 疑似重复关系列表 / 规则证据视图（全部经严格 DTO 脱敏）。
 * 写操作：委托既有 RadarDuplicateAdjudicationService 与 RadarRuleEvidenceService，
 * 在此仅追加乐观并发状态校验（expectedCurrentStatus / expectedOverrideState 不符→409）。
 *
 * 决策详情从 committedResult 载体还原：每个候选/快照最近一次 commit 的结构化决策，
 * 不新增 schema、不改动既有版本。
 */
import type {
  RadarAction,
  RadarCandidateNormalized,
  RadarCandidateRelation,
  RadarRuleAssessment,
} from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import { RadarCaptureRepository } from './captureRepository';
import { RadarCandidateRepository } from './candidateRepository';
import { RadarCandidateRelationRepository } from './candidateRelationRepository';
import { RadarSourceRecordRepository } from './sourceRecordRepository';
import { RadarActionRepository } from './actionRepository';
import { RadarRuleAssessmentRepository } from './ruleAssessmentRepository';
import {
  RadarDuplicateAdjudicationService,
  type DuplicateAdjudicationDeps,
} from './duplicateAdjudicationService';
import { RadarRuleEvidenceService } from './ruleEvidenceService';
import type { CommitOutcomeItem } from './service';
import { radarRelationNotFound, RadarCaptureError } from './errors';
import {
  REVIEW_JD_EXCERPT_MAX,
  type AdjudicationRequest,
  type CandidateDecisionDetail,
  type CandidateSummary,
  type ChangedFieldView,
  type DecisionFeedItem,
  type RecheckRequest,
  type RedactedSignals,
  type RelationListItem,
  type RelationListQuery,
  type RuleEvidenceView,
  type RuleOverrideRevertRequest,
  type RuleOverrideSetRequest,
} from './reviewDtoSchemas';

/** 人工工作台默认只显示待处理关系。 */
const DEFAULT_REVIEW_STATUSES = ['suspected_duplicate', 'needs_recheck'] as const;

function relationStatusConflict(expected: string, actual: string): RadarCaptureError {
  return new RadarCaptureError(409, {
    code: 'RELATION_STATE_CONFLICT',
    message: `数据已变化，请刷新：期望状态 ${expected}，当前为 ${actual}`,
  });
}

function overrideStateConflict(expected: string, actual: string): RadarCaptureError {
  return new RadarCaptureError(409, {
    code: 'OVERRIDE_STATE_CONFLICT',
    message: `数据已变化，请刷新：期望覆盖状态 ${expected}，当前为 ${actual}`,
  });
}

function ruleAssessmentNotFound(): RadarCaptureError {
  return new RadarCaptureError(404, { code: 'RULE_ASSESSMENT_NOT_FOUND', message: '规则评估不存在' });
}

/** 把契约里较宽的 before/after 值收窄到 DTO 允许的 scalar | string[] | null（对象序列化为字符串）。 */
function coerceChangeValue(v: unknown): string | number | boolean | string[] | null {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)));
  return JSON.stringify(v);
}

/** 把证据 raw/normalized 值收窄到 scalar | null（对象/数组序列化为字符串）。 */
function coerceScalar(v: unknown): string | number | boolean | null {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  return JSON.stringify(v);
}

export class RadarReviewService {
  private readonly captures: RadarCaptureRepository;
  private readonly candidates: RadarCandidateRepository;
  private readonly relations: RadarCandidateRelationRepository;
  private readonly sourceRecords: RadarSourceRecordRepository;
  private readonly actions: RadarActionRepository;
  private readonly adjudication: RadarDuplicateAdjudicationService;
  private readonly ruleEvidence: RadarRuleEvidenceService;

  constructor(
    private readonly db: SqliteDatabase,
    deps: DuplicateAdjudicationDeps,
  ) {
    this.captures = new RadarCaptureRepository(db);
    this.candidates = new RadarCandidateRepository(db);
    this.relations = new RadarCandidateRelationRepository(db);
    this.sourceRecords = new RadarSourceRecordRepository(db);
    this.actions = new RadarActionRepository(db);
    this.adjudication = new RadarDuplicateAdjudicationService(db, deps);
    this.ruleEvidence = new RadarRuleEvidenceService(db, deps);
  }

  /* ============ 只读 ============ */

  /** 候选决策详情：从 committedResult 还原最近决策 + 版本链 + 来源。 */
  getCandidateDecisionDetail(candidateId: string): CandidateDecisionDetail {
    const candidate = this.candidates.getCandidate(candidateId);
    if (candidate === null) throw radarRelationNotFound();

    const outcome = this.latestOutcomeForCandidate(candidateId);
    const currentVersion = candidate.activeVersionId === null
      ? null
      : this.candidates.getVersion(candidate.activeVersionId);
    const previousVersionId = currentVersion?.supersedesVersionId ?? null;
    const previousVersion = previousVersionId === null ? null : this.candidates.getVersion(previousVersionId);

    const decision = outcome?.decision ?? null;
    const changedFields: ChangedFieldView[] = (decision?.changedFields ?? []).map((c) => ({
      fieldPath: c.fieldPath,
      before: coerceChangeValue(c.before),
      after: coerceChangeValue(c.after),
      classification: c.classification,
      reason: c.reason,
    }));

    return {
      candidateId,
      activeCandidateVersionId: candidate.activeVersionId,
      decisionType: outcome?.decisionType ?? (previousVersion === null ? 'new_identity' : 'material_change'),
      analysisEligible: outcome?.analysisEligible ?? false,
      blockingIssues: decision?.blockingIssues ?? [],
      needsConfirmation: decision?.needsConfirmation ?? [],
      conflictReason: decision?.conflictReason ?? null,
      changedFields,
      latestSnapshotId: outcome?.snapshotId ?? null,
      currentVersion: currentVersion === null
        ? null
        : this.summaryFromNormalized(candidateId, currentVersion.id, currentVersion.normalized),
      previousVersion: previousVersion === null
        ? null
        : this.summaryFromNormalized(candidateId, previousVersion.id, previousVersion.normalized),
      sourceLinks: this.candidates.listSourceLinks(candidateId).map((link) => {
        const src = this.sourceRecords.getById(link.sourceRecordId);
        return {
          sourceRecordId: link.sourceRecordId,
          linkReason: link.linkReason,
          normalizedSourceUrl: src?.normalizedSourceUrl ?? null,
        };
      }),
    };
  }

  /**
   * 决策审阅 feed：扫描 committed 会话 outcomes，返回非 no_change 决策（去重取每候选/快照最近一次），
   * 覆盖有候选的 material/regression/ambiguous 与无候选的 identity_conflict（供阻断信息区展示）。
   */
  listDecisionFeed(limit = 50): DecisionFeedItem[] {
    const byKey = new Map<string, DecisionFeedItem>();
    for (const session of this.captures.listCommittedSessions()) {
      for (const outcome of this.readOutcomes(session.rawInput)) {
        const decisionType = outcome.decisionType ?? 'no_change';
        if (decisionType === 'no_change' || decisionType === 'snapshot_only') continue;
        const key = outcome.candidateId ?? `snap:${outcome.snapshotId}`;
        const decision = outcome.decision ?? null;
        byKey.set(key, {
          snapshotId: outcome.snapshotId,
          candidateId: outcome.candidateId,
          activeCandidateVersionId: outcome.candidateVersionId,
          decisionType,
          analysisEligible: outcome.analysisEligible ?? false,
          blockingIssues: decision?.blockingIssues ?? [],
          needsConfirmation: decision?.needsConfirmation ?? [],
          conflictReason: decision?.conflictReason ?? null,
          changedFieldPaths: (decision?.changedFields ?? []).map((c) => c.fieldPath),
          summary: outcome.candidateId === null ? null : this.candidateSummary(outcome.candidateId),
        });
      }
    }
    return [...byKey.values()].slice(0, limit);
  }

  /** 关系列表：默认 suspected_duplicate + needs_recheck；含两侧候选摘要与脱敏 signals。 */
  listRelations(query: RelationListQuery): RelationListItem[] {
    const statuses = query.statuses ?? [...DEFAULT_REVIEW_STATUSES];
    const limit = query.limit ?? 50;
    const seen = new Set<string>();
    const items: RelationListItem[] = [];
    for (const status of statuses) {
      for (const rel of this.relations.listByStatus(status)) {
        if (seen.has(rel.id)) continue;
        seen.add(rel.id);
        items.push(this.toRelationListItem(rel));
        if (items.length >= limit) return items;
      }
    }
    return items;
  }

  /** 某候选版本的规则证据视图（structured / legacy_scalar / corrupt + 覆盖状态）。 */
  listRuleEvidence(candidateVersionId: string): RuleEvidenceView[] {
    return this.ruleEvidence.listEvidenceByVersion(candidateVersionId).map((view) => {
      const overrideState = this.currentOverrideState(view.assessment.id, view.assessment.candidateId);
      if (view.evidenceState === 'structured') {
        const e = view.evidence;
        return {
          assessmentId: view.assessment.id, ruleKey: view.assessment.ruleKey, evidenceState: 'structured' as const,
          corruptReason: null, overrideState,
          ruleId: e.ruleId, ruleVersion: e.ruleVersion, outcome: e.outcome,
          matchedFieldPath: e.matchedFieldPath, rawValue: coerceScalar(e.rawValue), normalizedValue: coerceScalar(e.normalizedValue),
          excerpt: e.evidenceExcerpt, explanation: e.explanation, confidence: e.confidence, blocking: e.blocking,
          matchedText: view.assessment.matchedText,
        };
      }
      const corruptReason = view.evidenceState === 'corrupt' ? view.corruptReason : null;
      return {
        assessmentId: view.assessment.id, ruleKey: view.assessment.ruleKey, evidenceState: view.evidenceState,
        corruptReason, overrideState,
        ruleId: null, ruleVersion: null, outcome: null, matchedFieldPath: null,
        rawValue: null, normalizedValue: null, excerpt: null, explanation: null, confidence: null, blocking: null,
        matchedText: view.assessment.matchedText,
      };
    });
  }

  /* ============ 写（乐观并发校验后委托既有 service） ============ */

  confirmSame(req: AdjudicationRequest): RadarCandidateRelation {
    return this.guardRelation(req.relationId, req.expectedCurrentStatus, (current) =>
      // 幂等：已是 confirmed_same 时直接返回，不再追加事件。
      current.status === 'confirmed_same' ? current : this.adjudication.confirmSame(req.relationId, req.reason));
  }

  confirmDistinct(req: AdjudicationRequest): RadarCandidateRelation {
    return this.guardRelation(req.relationId, req.expectedCurrentStatus, (current) =>
      current.status === 'confirmed_distinct' ? current : this.adjudication.confirmDistinct(req.relationId, req.reason));
  }

  revertDecision(req: AdjudicationRequest): RadarCandidateRelation {
    return this.guardRelation(req.relationId, req.expectedCurrentStatus, () =>
      this.adjudication.revertDecision(req.relationId, req.reason));
  }

  requestRecheck(req: RecheckRequest): RadarCandidateRelation {
    return this.guardRelation(req.relationId, req.expectedCurrentStatus, (current) =>
      current.status === 'needs_recheck'
        ? current
        : this.adjudication.requestRecheck(req.relationId, req.evidenceReason, req.reason));
  }

  setRuleOverride(req: RuleOverrideSetRequest, actor: string): RadarAction {
    const assessment = this.requireAssessment(req.assessmentId);
    const current = this.currentOverrideState(assessment.id, assessment.candidateId);
    if (current !== req.expectedOverrideState) throw overrideStateConflict(req.expectedOverrideState, current);
    return this.ruleEvidence.setRuleOverride({
      assessment, decision: req.overriddenValue, reason: req.reason, actor, sourceSnapshotId: null,
    });
  }

  revertRuleOverride(req: RuleOverrideRevertRequest, actor: string): RadarAction {
    const assessment = this.requireAssessment(req.assessmentId);
    const current = this.currentOverrideState(assessment.id, assessment.candidateId);
    if (current !== req.expectedOverrideState) throw overrideStateConflict(req.expectedOverrideState, current);
    const setAction = this.latestOverrideSetAction(assessment.id, assessment.candidateId);
    if (setAction === null) throw overrideStateConflict(req.expectedOverrideState, 'none');
    return this.ruleEvidence.revertRuleOverride({ overrideActionId: setAction.id, reason: req.reason, actor });
  }

  /* ============ 内部辅助 ============ */

  private guardRelation(
    relationId: string,
    expected: string,
    op: (current: RadarCandidateRelation) => RadarCandidateRelation,
  ): RadarCandidateRelation {
    const current = this.relations.getById(relationId);
    if (current === null) throw radarRelationNotFound();
    if (current.status !== expected) throw relationStatusConflict(expected, current.status);
    return op(current);
  }

  private toRelationListItem(rel: RadarCandidateRelation): RelationListItem {
    return {
      relationId: rel.id,
      candidateIdLow: rel.candidateIdLow,
      candidateIdHigh: rel.candidateIdHigh,
      status: rel.status,
      reasonCode: rel.reasonCode,
      signals: this.redactSignals(rel.signals),
      firstDetectedAt: rel.firstDetectedAt,
      lastDetectedAt: rel.lastDetectedAt,
      lowSummary: this.candidateSummary(rel.candidateIdLow),
      highSummary: this.candidateSummary(rel.candidateIdHigh),
      hasPriorDecision: rel.resolutionActionId !== null || rel.resolvedAt !== null,
    };
  }

  /** signals 白名单脱敏：只保留少数保守布尔/短字符串，丢弃其它任意字段。 */
  private redactSignals(raw: unknown): RedactedSignals {
    const out: RedactedSignals = {};
    if (raw === null || typeof raw !== 'object') return out;
    const s = raw as Record<string, unknown>;
    if (typeof s.companyNameSimilar === 'boolean') out.companyNameSimilar = s.companyNameSimilar;
    if (typeof s.roleTitleSimilar === 'boolean') out.roleTitleSimilar = s.roleTitleSimilar;
    if (typeof s.sameSourceDomain === 'boolean') out.sameSourceDomain = s.sameSourceDomain;
    if (typeof s.sameNormalizedUrlHost === 'boolean') out.sameNormalizedUrlHost = s.sameNormalizedUrlHost;
    if (typeof s.reason === 'string') out.reason = s.reason.slice(0, 200);
    return out;
  }

  private candidateSummary(candidateId: string): CandidateSummary {
    const candidate = this.candidates.getCandidate(candidateId);
    const version = candidate?.activeVersionId == null ? null : this.candidates.getVersion(candidate.activeVersionId);
    if (version === null) {
      return {
        candidateId, activeCandidateVersionId: candidate?.activeVersionId ?? null,
        company: null, role: null, city: null, salaryMinK: null, salaryMaxK: null, salaryPeriod: null,
        experienceRequirement: null, educationRequirement: null, jdExcerpt: '',
        normalizedSourceUrl: null, sourceDomain: null,
      };
    }
    return this.summaryFromNormalized(candidateId, version.id, version.normalized);
  }

  private summaryFromNormalized(
    candidateId: string,
    versionId: string,
    n: RadarCandidateNormalized,
  ): CandidateSummary {
    const primary = this.candidates.listSourceLinks(candidateId).find((l) => l.linkReason === 'primary')
      ?? this.candidates.listSourceLinks(candidateId)[0] ?? null;
    const src = primary === null ? null : this.sourceRecords.getById(primary.sourceRecordId);
    return {
      candidateId,
      activeCandidateVersionId: versionId,
      company: n.company, role: n.role, city: n.city,
      salaryMinK: n.salaryMinK, salaryMaxK: n.salaryMaxK, salaryPeriod: n.salaryPeriod,
      experienceRequirement: n.experienceRequirement, educationRequirement: n.educationRequirement,
      jdExcerpt: (n.rawDescription ?? '').slice(0, REVIEW_JD_EXCERPT_MAX),
      normalizedSourceUrl: src?.normalizedSourceUrl ?? null,
      sourceDomain: null,
    };
  }

  /** 扫描 committed 会话，取该候选最近一次 commit 决策 outcome。 */
  private latestOutcomeForCandidate(candidateId: string): CommitOutcomeItem | null {
    let latest: CommitOutcomeItem | null = null;
    for (const session of this.captures.listCommittedSessions()) {
      for (const outcome of this.readOutcomes(session.rawInput)) {
        if (outcome.candidateId === candidateId) latest = outcome; // 会话按 committedAt 升序，后者更新
      }
    }
    return latest;
  }

  private readOutcomes(rawInput: unknown): CommitOutcomeItem[] {
    if (rawInput === null || typeof rawInput !== 'object') return [];
    const envelope = (rawInput as { committedResult?: unknown }).committedResult;
    if (envelope === null || typeof envelope !== 'object') return [];
    const outcomes = (envelope as { outcomes?: unknown }).outcomes;
    return Array.isArray(outcomes) ? (outcomes as CommitOutcomeItem[]) : [];
  }

  /** 通过 candidate_version_id 定位评估行，再取完整对象。 */
  private requireAssessment(assessmentId: string): RadarRuleAssessment {
    const row = this.db
      .prepare('SELECT candidate_version_id FROM radar_rule_assessments WHERE id = ?')
      .get(assessmentId) as { candidate_version_id: string } | undefined;
    if (row === undefined) throw ruleAssessmentNotFound();
    const repo = new RadarRuleAssessmentRepository(this.db);
    const hit = repo.listByCandidateVersion(row.candidate_version_id).find((a) => a.id === assessmentId);
    if (hit === undefined) throw ruleAssessmentNotFound();
    return hit;
  }

  /** 当前覆盖状态：candidate 下最近一条未被撤销的 rule_override_set（按该 assessment）。 */
  private currentOverrideState(assessmentId: string, candidateId: string): 'none' | 'pass' | 'block' {
    const setAction = this.latestOverrideSetAction(assessmentId, candidateId);
    if (setAction === null || setAction.revertedByActionId !== null) return 'none';
    const value = (setAction.metadata as { overriddenValue?: unknown }).overriddenValue;
    return value === 'pass' || value === 'block' ? value : 'none';
  }

  private latestOverrideSetAction(assessmentId: string, candidateId: string): RadarAction | null {
    // listByCandidate 按 occurredAt DESC 返回，取第一条匹配该 assessment 的 set。
    for (const action of this.actions.listByCandidate(candidateId)) {
      if (action.actionType !== 'rule_override_set') continue;
      if ((action.metadata as { ruleAssessmentId?: unknown }).ruleAssessmentId === assessmentId) return action;
    }
    return null;
  }
}

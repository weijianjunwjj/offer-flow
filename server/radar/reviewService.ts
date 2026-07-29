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
  REVIEW_SIGNAL_EXPLANATION_MAX,
  REVIEW_SIGNAL_MAX_COUNT,
  REVIEW_SIGNAL_VALUE_MAX,
  REVIEW_JD_EXCERPT_MAX,
  DuplicateSignalSchema,
  RELATION_AUDIT_ACTION_TYPES,
  type AdjudicationRequest,
  type CandidateDecisionDetail,
  type CandidateSummary,
  type ChangedFieldView,
  type DecisionFeedItem,
  type DuplicateSignal,
  type OverrideAuditEntry,
  type RecheckRequest,
  type RelationAuditEntry,
  type RelationDetail,
  type RelationListItem,
  type RelationListQuery,
  type RelationSignals,
  type RuleEvidenceView,
  type RuleOverrideRevertRequest,
  type RuleOverrideSetRequest,
} from './reviewDtoSchemas';
import { createHash } from 'node:crypto';
import type { RadarCandidateRelationStatus } from '../../src/domain/radar';
import { currentOverrideState } from './ruleOverrideProjection';

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

  /**
   * 关系详情（任意状态，含 confirmed_distinct/confirmed_same，供已裁决关系重新打开查看）：
   * 当前状态 + 原因码 + 用户裁决原因 + 时间 + 结构化 signals + 两侧候选 + 只读审计时间线。
   */
  getRelationDetail(relationId: string): RelationDetail {
    const rel = this.relations.getById(relationId);
    if (rel === null) throw radarRelationNotFound();
    const timeline = this.buildRelationAuditTimeline(rel);
    const latestDecision = [...timeline].reverse().find((e) => e.actionType !== 'duplicate_recheck_requested') ?? null;
    return {
      relationId: rel.id,
      candidateIdLow: rel.candidateIdLow,
      candidateIdHigh: rel.candidateIdHigh,
      status: rel.status,
      reasonCode: rel.reasonCode,
      decisionReason: latestDecision?.reason ?? null,
      signals: this.parseSignals(rel.signals),
      firstDetectedAt: rel.firstDetectedAt,
      lastDetectedAt: rel.lastDetectedAt,
      decidedAt: rel.resolvedAt,
      lowSummary: this.candidateSummary(rel.candidateIdLow),
      highSummary: this.candidateSummary(rel.candidateIdHigh),
      auditTimeline: timeline,
    };
  }

  /**
   * 从既有 RadarAction 只读聚合该关系的裁决审计（duplicate_* 事件，时间升序）。
   * 审计锚定在 candidateIdLow，故按该候选取动作、以 metadata.relationId 过滤本关系；
   * 绝不改写/删除旧事件，resulting/previous 状态直接读取事件当时的 metadata。
   */
  private buildRelationAuditTimeline(rel: RadarCandidateRelation): RelationAuditEntry[] {
    const auditTypes = new Set<string>(RELATION_AUDIT_ACTION_TYPES);
    const resulting: Record<string, RadarCandidateRelationStatus> = {
      duplicate_confirmed: 'confirmed_same',
      duplicate_rejected: 'confirmed_distinct',
      duplicate_decision_reverted: 'suspected_duplicate',
      duplicate_recheck_requested: 'needs_recheck',
    };
    const entries: RelationAuditEntry[] = [];
    for (const action of this.actions.listByCandidate(rel.candidateIdLow)) {
      if (!auditTypes.has(action.actionType)) continue;
      const meta = (action.metadata ?? {}) as Record<string, unknown>;
      if (meta.relationId !== rel.id) continue;
      const prev = typeof meta.previousStatus === 'string' ? meta.previousStatus : null;
      entries.push({
        actionId: action.id,
        actionType: action.actionType as RelationAuditEntry['actionType'],
        reason: action.reasonText,
        evidenceReason: typeof meta.evidenceReason === 'string' ? meta.evidenceReason : null,
        previousStatus: this.asRelationStatus(prev),
        resultingStatus: resulting[action.actionType] ?? rel.status,
        occurredAt: action.occurredAt,
        reverted: action.revertedByActionId !== null,
      });
    }
    // listByCandidate 为 occurredAt DESC，这里翻转为升序（旧→新）便于阅读全过程。
    return entries.reverse().slice(0, 100);
  }

  private asRelationStatus(v: string | null): RadarCandidateRelationStatus | null {
    const all: readonly string[] = ['suspected_duplicate', 'confirmed_same', 'confirmed_distinct', 'needs_recheck', 'superseded'];
    return v !== null && all.includes(v) ? (v as RadarCandidateRelationStatus) : null;
  }

  /** 某候选版本的规则证据视图（structured / legacy_scalar / corrupt + 覆盖状态）。 */
  listRuleEvidence(candidateVersionId: string): RuleEvidenceView[] {
    return this.ruleEvidence.listEvidenceByVersion(candidateVersionId).map((view) => {
      const overrideState = this.currentOverrideState(view.assessment.id, view.assessment.candidateId);
      // 只读附加：原始评估标识 + evidence_json 短哈希 + 覆盖审计时间线（证明原评估从不被修改）。
      const originalResult = view.assessment.result;
      const evidenceHashShort = this.evidenceHashShort(view.assessment.evidenceJson);
      const overrideAudit = this.buildOverrideAudit(view.assessment.id, view.assessment.candidateId);
      if (view.evidenceState === 'structured') {
        const e = view.evidence;
        return {
          assessmentId: view.assessment.id, ruleKey: view.assessment.ruleKey, evidenceState: 'structured' as const,
          corruptReason: null, overrideState, originalResult, evidenceHashShort, overrideAudit,
          ruleId: e.ruleId, ruleVersion: e.ruleVersion, outcome: e.outcome,
          matchedFieldPath: e.matchedFieldPath, rawValue: coerceScalar(e.rawValue), normalizedValue: coerceScalar(e.normalizedValue),
          excerpt: e.evidenceExcerpt, explanation: e.explanation, confidence: e.confidence, blocking: e.blocking,
          matchedText: view.assessment.matchedText,
        };
      }
      const corruptReason = view.evidenceState === 'corrupt' ? view.corruptReason : null;
      return {
        assessmentId: view.assessment.id, ruleKey: view.assessment.ruleKey, evidenceState: view.evidenceState,
        corruptReason, overrideState, originalResult, evidenceHashShort, overrideAudit,
        ruleId: null, ruleVersion: null, outcome: null, matchedFieldPath: null,
        rawValue: null, normalizedValue: null, excerpt: null, explanation: null, confidence: null, blocking: null,
        matchedText: view.assessment.matchedText,
      };
    });
  }

  /** evidence_json 的 SHA-256 前 12 位（稳定短摘要，证明证据未被覆盖操作改动）；NULL 证据返回 null。 */
  private evidenceHashShort(evidenceJson: string | null): string | null {
    if (evidenceJson === null) return null;
    return createHash('sha256').update(evidenceJson, 'utf8').digest('hex').slice(0, 12);
  }

  /**
   * 某评估的规则覆盖审计（rule_override_set / reverted，时间升序，append-only）。
   * previous/resulting 覆盖态由升序遍历推导：set→overriddenValue，reverted→none。
   */
  private buildOverrideAudit(assessmentId: string, candidateId: string): OverrideAuditEntry[] {
    // listByCandidate 为 DESC；翻转升序后遍历以推导状态转移。
    const actions = [...this.actions.listByCandidate(candidateId)].reverse();
    const setIds = new Set<string>();
    const entries: OverrideAuditEntry[] = [];
    let state: 'none' | 'pass' | 'block' = 'none';
    for (const action of actions) {
      const meta = (action.metadata ?? {}) as Record<string, unknown>;
      if (action.actionType === 'rule_override_set' && meta.ruleAssessmentId === assessmentId) {
        setIds.add(action.id);
        const value = meta.overriddenValue === 'pass' || meta.overriddenValue === 'block' ? meta.overriddenValue : null;
        const previous = state;
        state = value ?? state;
        entries.push({
          actionId: action.id, actionType: 'rule_override_set', reason: action.reasonText,
          overriddenValue: value, previousOverrideState: previous, resultingOverrideState: state,
          occurredAt: action.occurredAt, reverted: action.revertedByActionId !== null,
        });
      } else if (action.actionType === 'rule_override_reverted' && typeof meta.revertsActionId === 'string' && setIds.has(meta.revertsActionId)) {
        const previous = state;
        state = 'none';
        entries.push({
          actionId: action.id, actionType: 'rule_override_reverted', reason: action.reasonText,
          overriddenValue: null, previousOverrideState: previous, resultingOverrideState: state,
          occurredAt: action.occurredAt, reverted: action.revertedByActionId !== null,
        });
      }
    }
    return entries.slice(0, 100);
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
      signals: this.parseSignals(rel.signals),
      firstDetectedAt: rel.firstDetectedAt,
      lastDetectedAt: rel.lastDetectedAt,
      lowSummary: this.candidateSummary(rel.candidateIdLow),
      highSummary: this.candidateSummary(rel.candidateIdHigh),
      hasPriorDecision: rel.resolutionActionId !== null || rel.resolvedAt !== null,
    };
  }

  /**
   * 从 signals_json 安全解析结构化疑似信号：
   * - 读取 `signals` 数组（历史布尔对象形态自动归一为结构化条目），逐条严格 Zod 校验；
   * - 值/字段限长、strength 收窄到 [0,1]，最多 20 条；非法条目丢弃、不静默透传任意 JSON；
   * - signals_json 存在但完全无法解析出任何信号 → corrupt（明确标记，不当作 empty）。
   */
  private parseSignals(raw: unknown): RelationSignals {
    if (raw === null || raw === undefined) return { state: 'empty', signals: [], corruptReason: null };
    if (typeof raw !== 'object') {
      return { state: 'corrupt', signals: [], corruptReason: 'signals_json 不是对象' };
    }
    const container = raw as Record<string, unknown>;
    const rawList = Array.isArray(container.signals)
      ? container.signals
      : this.legacyBooleanSignals(container);
    if (rawList.length === 0) {
      // 无 signals 数组、也无可归一的历史布尔字段：视为无信号（empty），非损坏。
      return { state: 'empty', signals: [], corruptReason: null };
    }
    const signals: DuplicateSignal[] = [];
    let rejected = 0;
    for (const entry of rawList.slice(0, REVIEW_SIGNAL_MAX_COUNT)) {
      const narrowed = this.narrowSignal(entry);
      const parsed = DuplicateSignalSchema.safeParse(narrowed);
      if (parsed.success) signals.push(parsed.data);
      else rejected += 1;
    }
    if (signals.length === 0) {
      return { state: 'corrupt', signals: [], corruptReason: 'signals_json 存在但无合法信号条目' };
    }
    const corruptReason = rejected > 0 ? `已丢弃 ${rejected} 条非法信号条目` : null;
    return { state: 'present', signals, corruptReason };
  }

  /** 历史布尔对象（companyNameSimilar 等）→ 结构化信号条目，保证旧数据也可展示。 */
  private legacyBooleanSignals(s: Record<string, unknown>): unknown[] {
    const out: unknown[] = [];
    const push = (type: string, field: string, explanation: string) => {
      out.push({ signalType: type, field, candidateAValue: true, candidateBValue: true, strength: null, explanation });
    };
    if (s.companyNameSimilar === true) push('company_name_similar', 'company', '公司名相似');
    if (s.roleTitleSimilar === true) push('role_title_similar', 'role', '岗位名相似');
    if (s.sameSourceDomain === true) push('same_source_domain', 'sourceDomain', '同一来源域名');
    if (s.sameNormalizedUrlHost === true) push('same_normalized_url_host', 'sourceUrl', '规范化 URL 主机相同');
    if (typeof s.reason === 'string' && out.length > 0) {
      (out[0] as { explanation: string }).explanation = s.reason.slice(0, REVIEW_SIGNAL_EXPLANATION_MAX);
    }
    return out;
  }

  /** 单条原始信号收窄到 DTO 允许的形状（字段/值限长、strength 数字化），交由 Zod 终校验。 */
  private narrowSignal(entry: unknown): unknown {
    if (entry === null || typeof entry !== 'object') return entry;
    const e = entry as Record<string, unknown>;
    const clampStr = (v: unknown): string => (typeof v === 'string' ? v.slice(0, REVIEW_SIGNAL_VALUE_MAX) : '');
    const scalarOrNull = (v: unknown): string | number | boolean | null => {
      if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
      if (typeof v === 'string') return v.slice(0, REVIEW_SIGNAL_VALUE_MAX);
      return null;
    };
    const strength = typeof e.strength === 'number'
      ? Math.max(0, Math.min(1, e.strength))
      : (typeof e.confidence === 'number' ? Math.max(0, Math.min(1, e.confidence)) : null);
    return {
      signalType: clampStr(e.signalType),
      field: clampStr(e.field),
      candidateAValue: scalarOrNull(e.candidateAValue),
      candidateBValue: scalarOrNull(e.candidateBValue),
      strength,
      explanation: typeof e.explanation === 'string' ? e.explanation.slice(0, REVIEW_SIGNAL_EXPLANATION_MAX) : '',
    };
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

  /** 当前覆盖状态：委托 ruleOverrideProjection 的权威算法（candidate 下最近未撤销的 set）。 */
  private currentOverrideState(assessmentId: string, candidateId: string): 'none' | 'pass' | 'block' {
    return currentOverrideState(this.actions.listByCandidate(candidateId), assessmentId);
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

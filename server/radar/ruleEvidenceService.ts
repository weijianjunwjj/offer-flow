/**
 * V8-3 / RC-06 规则证据读写与用户覆盖审计（Wave 5）。
 *
 * 设计依据：docs/technical/offerflow-v0.8-v8-3-normalization-dedup-change-design.md §9/§10；
 * evidence_json 载体与 ruleEvidenceContract 已在 Wave 1.5 就绪。
 *
 * 严格边界：
 * - 新规则评估写入合法 evidence_json（经契约校验，超限/非法拒绝，绝不写入非法证据）；
 * - 旧 NULL evidence 行回退 scalar 字段；非 NULL 但损坏的证据明确标记 corrupt，不静默忽略；
 * - unknown 与 false(not_matched)、rule_error 与 not_matched 严格区分（由契约 outcome 表达）；
 * - 规则评估追加式，旧结果不 UPDATE、不删除；
 * - 用户覆盖只经 RadarAction 追加记录（rule_override_set/reverted），不改 RuleAssessment、
 *   不改 Snapshot、不改 CandidateVersion；恢复默认也追加新事件。
 */
import type { RadarAction, RadarRuleAssessment } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import { RadarActionRepository } from './actionRepository';
import { RadarRuleAssessmentRepository } from './ruleAssessmentRepository';
import { parseRuleEvidenceJson, serializeRuleEvidence, type RuleEvidence } from './ruleEvidenceContract';

export interface RuleEvidenceServiceDeps {
  now: () => number;
  createId: () => string;
}

/** 读取视图：证据要么是 valid 契约对象、要么标记 legacy(仅 scalar)/corrupt(非 NULL 但校验失败)。 */
export type RuleAssessmentEvidenceView =
  | { assessment: RadarRuleAssessment; evidenceState: 'structured'; evidence: RuleEvidence }
  | { assessment: RadarRuleAssessment; evidenceState: 'legacy_scalar'; evidence: null }
  | { assessment: RadarRuleAssessment; evidenceState: 'corrupt'; evidence: null; corruptReason: string };

export class RadarRuleEvidenceService {
  private readonly assessments: RadarRuleAssessmentRepository;
  private readonly actions: RadarActionRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: RuleEvidenceServiceDeps,
  ) {
    this.assessments = new RadarRuleAssessmentRepository(db);
    this.actions = new RadarActionRepository(db);
  }

  /**
   * 写入一条规则评估。evidence 必经契约校验后序列化为 evidence_json（非法/超限抛错）。
   * 同时保留 scalar 摘要字段（matched_text/source_path/explanation）用于兼容读取。
   */
  recordAssessment(input: {
    id: string;
    candidateId: string;
    candidateVersionId: string;
    ruleVersion: string;
    ruleKey: string;
    category: RadarRuleAssessment['category'];
    severity: string;
    result: RadarRuleAssessment['result'];
    matchedText: string | null;
    sourcePath: string | null;
    explanation: string;
    evidence: RuleEvidence;
  }): void {
    const evidenceJson = serializeRuleEvidence(input.evidence);
    this.assessments.insert({
      id: input.id,
      candidateId: input.candidateId,
      candidateVersionId: input.candidateVersionId,
      ruleVersion: input.ruleVersion,
      ruleKey: input.ruleKey,
      category: input.category,
      severity: input.severity,
      result: input.result,
      matchedText: input.matchedText,
      sourcePath: input.sourcePath,
      explanation: input.explanation,
      evidenceJson,
      createdAt: this.deps.now(),
    });
  }

  /**
   * 读取某版本的全部规则评估，并把 evidence_json 解析为结构化 / legacy / corrupt 视图。
   * evidence_json 为 NULL → legacy_scalar（回退 scalar 字段）；非 NULL 但校验失败 → corrupt（明确标记）。
   */
  listEvidenceByVersion(candidateVersionId: string): RuleAssessmentEvidenceView[] {
    return this.assessments.listByCandidateVersion(candidateVersionId).map((assessment) => {
      if (assessment.evidenceJson === null) {
        return { assessment, evidenceState: 'legacy_scalar' as const, evidence: null };
      }
      const parsed = parseRuleEvidenceJson(assessment.evidenceJson);
      if (parsed.status === 'valid') {
        return { assessment, evidenceState: 'structured' as const, evidence: parsed.evidence };
      }
      return { assessment, evidenceState: 'corrupt' as const, evidence: null, corruptReason: parsed.reason };
    });
  }

  /**
   * 用户覆盖某条规则评估结果（追加式 RadarAction，不改 RuleAssessment）。
   * decision: 'pass' 表示用户判定该规则不该阻断；'block' 表示坚持阻断。
   */
  setRuleOverride(input: {
    assessment: RadarRuleAssessment;
    decision: 'pass' | 'block';
    reason: string;
    actor: string;
    sourceSnapshotId: string | null;
  }): RadarAction {
    const now = this.deps.now();
    const action: RadarAction = {
      id: this.deps.createId(),
      candidateId: input.assessment.candidateId,
      candidateVersionId: input.assessment.candidateVersionId,
      actionType: 'rule_override_set',
      reasonCode: input.assessment.ruleKey,
      reasonText: input.reason,
      metadata: {
        ruleAssessmentId: input.assessment.id,
        ruleVersion: input.assessment.ruleVersion,
        originalResult: input.assessment.result,
        overriddenValue: input.decision,
        actor: input.actor,
        sourceSnapshotId: input.sourceSnapshotId,
      },
      occurredAt: now,
      revertedByActionId: null,
      createdAt: now,
    };
    this.actions.insert(action);
    return action;
  }

  /**
   * 撤销/恢复默认：追加 rule_override_reverted 事件，并回填被撤销事件的 reverted_by_action_id。
   * 不删除任何旧事件；恢复默认同样形成新记录（全过程可回放）。
   */
  revertRuleOverride(input: {
    overrideActionId: string;
    reason: string;
    actor: string;
  }): RadarAction {
    return this.db.transaction(() => {
      const original = this.actions.getById(input.overrideActionId);
      if (original === null) {
        throw new Error(`rule override action 不存在：${input.overrideActionId}`);
      }
      const now = this.deps.now();
      const revert: RadarAction = {
        id: this.deps.createId(),
        candidateId: original.candidateId,
        candidateVersionId: original.candidateVersionId,
        actionType: 'rule_override_reverted',
        reasonCode: original.reasonCode,
        reasonText: input.reason,
        metadata: {
          revertsActionId: original.id,
          actor: input.actor,
        },
        occurredAt: now,
        revertedByActionId: null,
        createdAt: now,
      };
      this.actions.insert(revert);
      this.actions.markReverted(original.id, revert.id);
      return revert;
    })();
  }
}

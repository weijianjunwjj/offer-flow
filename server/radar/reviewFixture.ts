/**
 * V8-3 人工评审工作台的确定性 fixture（Wave 6）。
 *
 * 经真实 service 落库，覆盖设计 §五 要求的 12 类场景。仅用于受控 v8 沙箱与集成测试，
 * 绝不写入真实生产库（data/offerflow.sqlite3）。
 */
import type { SqliteDatabase } from '../db';
import { RadarCaptureService } from './service';
import { RadarDuplicateAdjudicationService } from './duplicateAdjudicationService';
import { RadarRuleEvidenceService } from './ruleEvidenceService';
import { RadarRuleAssessmentRepository } from './ruleAssessmentRepository';
import type { RuleEvidence } from './ruleEvidenceContract';

export interface ReviewFixtureDeps {
  now: () => number;
  createId: () => string;
}

export interface ReviewFixtureResult {
  suspectedRelationId: string;
  distinctRelationId: string;
  recheckRelationId: string;
  materialCandidateId: string;
  regressionCandidateId: string;
  ambiguousCandidateId: string;
  identityConflictSnapshotId: string;
  evidenceVersionId: string;
  structuredAssessmentId: string;
  legacyAssessmentId: string;
  corruptAssessmentId: string;
  coveredAssessmentId: string;
  uncoveredAssessmentId: string;
}

interface RecognizedFields {
  company: string | null; role: string | null; city: string | null;
  salaryMinK: number | null; salaryMaxK: number | null; salaryPeriod: string | null;
  experienceRequirement: string | null; educationRequirement: string | null;
}
type Fields = RecognizedFields;

function fields(over: Partial<NonNullable<Fields>> = {}): NonNullable<Fields> {
  return {
    company: 'A公司', role: '前端工程师', city: '苏州',
    salaryMinK: 15, salaryMaxK: 25, salaryPeriod: '月',
    experienceRequirement: '3-5年', educationRequirement: '本科', ...over,
  };
}

/**
 * 建立完整评审 fixture。返回各场景关键 ID 供沙箱 seed 输出与集成测试断言使用。
 */
export function seedReviewFixture(db: SqliteDatabase, deps: ReviewFixtureDeps): ReviewFixtureResult {
  const capture = new RadarCaptureService(db, deps);
  const adjudication = new RadarDuplicateAdjudicationService(db, deps);

  /** 通过一次会话 commit 一个 BOSS 岗位，返回 outcome。 */
  const commitBoss = (ext: string | null, url: string, recognized: NonNullable<Fields>) => {
    const s = capture.createSession({ sourceType: 'browser' });
    capture.addItem(s.session.id, {
      captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
      sourceUrl: url, sourceDomain: 'zhipin.com', pageTitle: null,
      visibleText: `岗位描述：${recognized.role} @ ${recognized.company}，工作地 ${recognized.city ?? '未知'}。`,
      externalRecordId: ext, recognizedFields: recognized, extractionMetadata: null, capturedAt: null,
    });
    return capture.commitSession(s.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
  };

  // (1) 独立候选 A/B → 登记疑似重复。
  const a = commitBoss('dup-a', 'https://www.zhipin.com/job_detail/dup-a.html', fields({ company: '同城科技' }));
  const b = commitBoss('dup-b', 'https://www.zhipin.com/job_detail/dup-b.html', fields({ company: '同城科技(分部)' }));
  const suspected = adjudication.registerSuspectedDuplicate(a.candidateId!, b.candidateId!, { companyNameSimilar: true, roleTitleSimilar: true, reason: '公司名高度相似' }, 'same_company_role');

  // (2) confirmed_distinct 一组。
  const c = commitBoss('dist-c', 'https://www.zhipin.com/job_detail/dist-c.html', fields({ company: '蓝鲸网络' }));
  const d = commitBoss('dist-d', 'https://www.zhipin.com/job_detail/dist-d.html', fields({ company: '蓝鲸传媒' }));
  const distinctRel = adjudication.registerSuspectedDuplicate(c.candidateId!, d.candidateId!, { companyNameSimilar: true }, 'same_company_role');
  adjudication.confirmDistinct(distinctRel.id, '两家为不同法人主体');

  // (3) needs_recheck 一组（先 confirmed_distinct 再新证据 recheck）。
  const e = commitBoss('rc-e', 'https://www.zhipin.com/job_detail/rc-e.html', fields({ company: '橙子云' }));
  const f = commitBoss('rc-f', 'https://www.zhipin.com/job_detail/rc-f.html', fields({ company: '橙子云科技' }));
  const recheckRel = adjudication.registerSuspectedDuplicate(e.candidateId!, f.candidateId!, { companyNameSimilar: true }, 'same_company_role');
  adjudication.confirmDistinct(recheckRel.id, '暂判不同');
  adjudication.requestRecheck(recheckRel.id, 'new_material_version', '出现新的实质版本，请复核');

  // (7) material_change：同一岗位再次采集，薪资上调。
  commitBoss('mat-1', 'https://www.zhipin.com/job_detail/mat-1.html', fields({ company: '越迁软件', salaryMinK: 15, salaryMaxK: 25 }));
  const material = commitBoss('mat-1', 'https://www.zhipin.com/job_detail/mat-1.html', fields({ company: '越迁软件', salaryMinK: 20, salaryMaxK: 35 }));

  // (5) extraction_regression：已知城市 → 再次采集变 unknown。
  commitBoss('reg-1', 'https://www.zhipin.com/job_detail/reg-1.html', fields({ company: '云栖数据', city: '苏州' }));
  const regression = commitBoss('reg-1', 'https://www.zhipin.com/job_detail/reg-1.html', fields({ company: '云栖数据', city: null }));

  // (6) ambiguous_change：再次采集时 company==role 冲突。
  commitBoss('amb-1', 'https://www.zhipin.com/job_detail/amb-1.html', fields({ company: '灯塔智能', role: '后端工程师' }));
  const ambiguous = commitBoss('amb-1', 'https://www.zhipin.com/job_detail/amb-1.html', fields({ company: '数据平台工程师', role: '数据平台工程师' }));

  // (4) identity_conflict：同 provider+URL 建两条来源（不同 externalId），再以无 externalId 的采集触发 Tier2 多命中。
  const conflictUrl = 'https://www.zhipin.com/job_detail/conflict-x.html';
  commitBoss('conf-1', conflictUrl, fields({ company: '同址甲' }));
  commitBoss('conf-2', conflictUrl, fields({ company: '同址乙' }));
  const conflict = commitBoss(null, conflictUrl, fields({ company: '同址触发冲突' }));

  const evidence = seedEvidence(db, deps, material.candidateVersionId!);

  return {
    suspectedRelationId: suspected.id,
    distinctRelationId: distinctRel.id,
    recheckRelationId: recheckRel.id,
    materialCandidateId: material.candidateId!,
    regressionCandidateId: regression.candidateId!,
    ambiguousCandidateId: ambiguous.candidateId!,
    identityConflictSnapshotId: conflict.snapshotId,
    ...evidence,
  };
}

function evidenceFor(candidateId: string, versionId: string, ruleId: string, over: Partial<RuleEvidence> = {}): RuleEvidence {
  return {
    contractVersion: 1, ruleId, ruleVersion: 'rules-v1', ruleCategory: 'hard_constraint',
    candidateId, candidateVersionId: versionId, outcome: 'matched', sourceSnapshotId: 'snap-fixture',
    matchedFieldPath: 'salaryMinK', rawValue: '20', normalizedValue: 20,
    evidenceExcerpt: '薪资 20K 触及规则阈值', evidenceSource: 'normalized_field', explanation: '命中薪资下限规则',
    severity: 'blocking', confidence: 0.92, blocking: true, matches: [], userOverrideState: 'none', ...over,
  } as RuleEvidence;
}

/** 场景 8~12：structured / legacy_scalar / corrupt 证据 + 已覆盖/未覆盖规则。 */
function seedEvidence(
  db: SqliteDatabase,
  deps: ReviewFixtureDeps,
  versionId: string,
): Pick<ReviewFixtureResult, 'evidenceVersionId' | 'structuredAssessmentId' | 'legacyAssessmentId' | 'corruptAssessmentId' | 'coveredAssessmentId' | 'uncoveredAssessmentId'> {
  const ruleEvidence = new RadarRuleEvidenceService(db, deps);
  const assessments = new RadarRuleAssessmentRepository(db);
  const candidateId = (db.prepare('SELECT candidate_id AS c FROM radar_candidate_versions WHERE id = ?').get(versionId) as { c: string }).c;

  const structuredId = deps.createId();
  ruleEvidence.recordAssessment({
    id: structuredId, candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
    ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'blocking', result: 'hit',
    matchedText: '20K', sourcePath: 'salaryMinK', explanation: '命中薪资下限规则',
    evidence: evidenceFor(candidateId, versionId, 'salary_floor'),
  });

  // legacy_scalar：evidence_json = null。
  const legacyId = deps.createId();
  assessments.insert({
    id: legacyId, candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v0',
    ruleKey: 'city_whitelist', category: 'hard_constraint', severity: 'warn', result: 'hit',
    matchedText: '苏州', sourcePath: 'city', explanation: '旧式仅 scalar 证据', evidenceJson: null,
    createdAt: deps.now(),
  });

  // corrupt：evidence_json 非空但不合法。
  const corruptId = deps.createId();
  assessments.insert({
    id: corruptId, candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
    ruleKey: 'commute_radius', category: 'risk', severity: 'warn', result: 'hit',
    matchedText: null, sourcePath: null, explanation: '证据损坏样例',
    evidenceJson: '{"contractVersion":1,"broken":true}', createdAt: deps.now(),
  });

  // 已覆盖规则（structured 之上设置 override）。
  const coveredId = deps.createId();
  ruleEvidence.recordAssessment({
    id: coveredId, candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
    ruleKey: 'experience_ceiling', category: 'risk', severity: 'warn', result: 'hit',
    matchedText: '3-5年', sourcePath: 'experienceRequirement', explanation: '经验超限（将被人工覆盖）',
    evidence: evidenceFor(candidateId, versionId, 'experience_ceiling', { matchedFieldPath: 'experienceRequirement', outcome: 'matched', blocking: false, severity: 'warn' }),
  });
  const covered = assessments.listByCandidateVersion(versionId).find((a) => a.id === coveredId)!;
  ruleEvidence.setRuleOverride({ assessment: covered, decision: 'pass', reason: '该经验要求可接受', actor: 'reviewer', sourceSnapshotId: null });

  // 未覆盖规则（structured，保持 none）。
  const uncoveredId = deps.createId();
  ruleEvidence.recordAssessment({
    id: uncoveredId, candidateId, candidateVersionId: versionId, ruleVersion: 'rules-v1',
    ruleKey: 'education_floor', category: 'risk', severity: 'warn', result: 'hit',
    matchedText: '本科', sourcePath: 'educationRequirement', explanation: '学历要求（未覆盖）',
    evidence: evidenceFor(candidateId, versionId, 'education_floor', { matchedFieldPath: 'educationRequirement', outcome: 'matched', blocking: false, severity: 'warn' }),
  });

  return {
    evidenceVersionId: versionId,
    structuredAssessmentId: structuredId,
    legacyAssessmentId: legacyId,
    corruptAssessmentId: corruptId,
    coveredAssessmentId: coveredId,
    uncoveredAssessmentId: uncoveredId,
  };
}

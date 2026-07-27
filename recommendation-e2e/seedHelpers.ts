/**
 * V8-5 / V8-6 E2E 共享 seed 辅助（自 recommendation-e2e/harness.ts 提取，避免两套沙箱各存一份副本）。
 *
 * 只承载"经真实链路播种候选 + 直插 current 分析 / 硬约束评估"这类与门禁无关的构造逻辑；
 * 端口预留、Vite 配置、服务启动仍由各沙箱自己的 harness 决定（前后端 flag 组合不同）。
 */
import type { SqliteDatabase } from '../server/db';
import { RadarCandidateRepository } from '../server/radar/candidateRepository';
import { RadarCandidateRelationRepository } from '../server/radar/candidateRelationRepository';
import { RadarCaptureService } from '../server/radar/service';
import { AnalysisRecordRepository } from '../server/radar/analysisRecordRepository';
import { RadarRuleAssessmentRepository } from '../server/radar/ruleAssessmentRepository';
import { validPayload } from '../server/radar/analysis/contractFixtures';
import {
  JOB_MATCH_ANALYSIS_POLICY_VERSION, JOB_MATCH_ANALYSIS_PROMPT_VERSION,
} from '../server/radar/analysis/analysisPrompt';
import type {
  JobMatchAnalysisRecord, JobMatchRecommendation, JobMatchConfidence, RadarRuleAssessment,
} from '../src/domain/radar';

export interface SeedDeps { now: () => number; createId: () => string }
export interface SeededCandidate { candidateId: string; versionId: string }

export function countRow(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

/** 经采集桥落一个真实候选 + 正式版本（externalRecordId 区分不同候选）。 */
export function seedCandidate(db: SqliteDatabase, tag: string, deps: SeedDeps): SeededCandidate {
  const capture = new RadarCaptureService(db, deps);
  const s = capture.createSession({ sourceType: 'browser' });
  capture.addItem(s.session.id, {
    captureMethod: 'boss_current_page', providerKey: 'boss', providerVersion: null,
    sourceUrl: `https://www.zhipin.com/job_detail/${tag}.html`, sourceDomain: 'zhipin.com', pageTitle: null,
    visibleText: `岗位描述：后端工程师 @ 公司${tag}，工作地 苏州。`, externalRecordId: tag,
    recognizedFields: {
      company: `公司${tag}`, role: '后端工程师', city: '苏州', salaryMinK: 20, salaryMaxK: 35,
      salaryPeriod: '月', experienceRequirement: '3-5年', educationRequirement: '本科',
    },
    extractionMetadata: null, capturedAt: null,
  });
  const outcome = capture.commitSession(s.session.id, { confirmedIndexes: [0], corrections: [] }).outcomes[0]!;
  return { candidateId: outcome.candidateId!, versionId: outcome.candidateVersionId! };
}

export interface CurrentRecordOptions {
  recommendation: JobMatchRecommendation;
  confidence: JobMatchConfidence;
  ruleVersion?: string;
  tag: string;
  createdAt: number;
  /** 记录 id 前缀：两套沙箱各用自己的前缀，避免共用临时库时 id 撞车。 */
  idPrefix?: string;
}

/** 直插一条 current 分析记录：版本戳与 seed 正式上下文一致 → deriveAnalysisValidity=current。 */
export function insertCurrentRecord(
  db: SqliteDatabase, c: SeededCandidate, opts: CurrentRecordOptions,
): void {
  const record: JobMatchAnalysisRecord = {
    id: `${opts.idPrefix ?? 'rece2e'}-rec-${opts.tag}`, candidateId: c.candidateId, candidateVersionId: c.versionId,
    resumeVersionId: 'resume-ver-1', jobMatchProfileVersionId: 'jmp-ver-1', cityCode: 'suzhou',
    capabilityBaselineVersionId: null, marketPositionVersionId: null, strategyVersionId: null,
    ruleVersion: opts.ruleVersion ?? 'none', promptVersion: JOB_MATCH_ANALYSIS_PROMPT_VERSION,
    analysisPolicyVersion: JOB_MATCH_ANALYSIS_POLICY_VERSION, modelProvider: 'fake', modelName: 'fake-model',
    modelVersion: null, inputHash: `hash-${opts.tag}`, recommendation: opts.recommendation, confidence: opts.confidence,
    payload: validPayload({ recommendation: opts.recommendation, confidence: opts.confidence }),
    createdAt: opts.createdAt, supersedesAnalysisId: null,
  };
  new AnalysisRecordRepository(db).insert(record);
}

/** 硬约束命中评估（rules-v1）：令候选被推荐服务确定性排除，进入 blocked 清单。 */
export function insertHardConstraintHit(
  db: SqliteDatabase, c: SeededCandidate, tag: string, at: number, idPrefix = 'rece2e',
): void {
  const assessment: RadarRuleAssessment = {
    id: `${idPrefix}-ra-${tag}`, candidateId: c.candidateId, candidateVersionId: c.versionId, ruleVersion: 'rules-v1',
    ruleKey: 'salary_floor', category: 'hard_constraint', severity: 'high', result: 'hit',
    matchedText: null, sourcePath: null, explanation: '薪资不达标', evidenceJson: null, createdAt: at,
  };
  new RadarRuleAssessmentRepository(db).insert(assessment);
}

/** 解析关系两侧候选的当前正式版本 id（推荐 scope = review 页可见两侧 active 版本）。 */
export function relationScope(
  db: SqliteDatabase, relationId: string,
): { low: SeededCandidate; high: SeededCandidate } {
  const relation = new RadarCandidateRelationRepository(db).getById(relationId);
  if (relation === null) throw new Error(`关系不存在: ${relationId}`);
  const repo = new RadarCandidateRepository(db);
  const resolve = (candidateId: string) => {
    const versionId = repo.getCandidate(candidateId)?.activeVersionId;
    if (versionId === undefined || versionId === null) throw new Error(`候选无 active 版本: ${candidateId}`);
    return { candidateId, versionId };
  };
  return { low: resolve(relation.candidateIdLow), high: resolve(relation.candidateIdHigh) };
}

import type { JobMatchAnalysisRecord } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  jobMatchAnalysisRecordToParams,
  rowToJobMatchAnalysisRecord,
  type JobMatchAnalysisRecordRow,
} from './rowMappers';

const COLUMNS = `
  id, candidate_id, candidate_version_id, resume_version_id, job_match_profile_version_id,
  city_code, capability_baseline_version_id, market_position_version_id, strategy_version_id,
  rule_version, prompt_version, analysis_policy_version, model_provider, model_name,
  model_version, input_hash, recommendation, confidence, payload_json, created_at,
  supersedes_analysis_id
`;

/**
 * job_match_analysis_records 基础读写。写入即不可变（对应新分析走 supersedesAnalysisId 链接旧记录），
 * input_hash 唯一约束由 DB 层保证幂等（TD §10.2 命中已有成功记录则复用）。
 */
export class AnalysisRecordRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(record: JobMatchAnalysisRecord): void {
    this.db.prepare(`
      INSERT INTO job_match_analysis_records (
        id, candidate_id, candidate_version_id, resume_version_id, job_match_profile_version_id,
        city_code, capability_baseline_version_id, market_position_version_id, strategy_version_id,
        rule_version, prompt_version, analysis_policy_version, model_provider, model_name,
        model_version, input_hash, recommendation, confidence, payload_json, created_at,
        supersedes_analysis_id
      ) VALUES (
        @id, @candidateId, @candidateVersionId, @resumeVersionId, @jobMatchProfileVersionId,
        @cityCode, @capabilityBaselineVersionId, @marketPositionVersionId, @strategyVersionId,
        @ruleVersion, @promptVersion, @analysisPolicyVersion, @modelProvider, @modelName,
        @modelVersion, @inputHash, @recommendation, @confidence, @payloadJson, @createdAt,
        @supersedesAnalysisId
      )
    `).run(jobMatchAnalysisRecordToParams(record));
  }

  getById(id: string): JobMatchAnalysisRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM job_match_analysis_records WHERE id = ?`)
      .get(id) as JobMatchAnalysisRecordRow | undefined;
    return row === undefined ? null : rowToJobMatchAnalysisRecord(row);
  }

  findByInputHash(inputHash: string): JobMatchAnalysisRecord | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM job_match_analysis_records WHERE input_hash = ?`)
      .get(inputHash) as JobMatchAnalysisRecordRow | undefined;
    return row === undefined ? null : rowToJobMatchAnalysisRecord(row);
  }

  listByCandidate(candidateId: string): JobMatchAnalysisRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM job_match_analysis_records WHERE candidate_id = ? ORDER BY created_at DESC, id DESC`)
      .all(candidateId) as JobMatchAnalysisRecordRow[];
    return rows.map(rowToJobMatchAnalysisRecord);
  }

  listByCandidateVersion(candidateVersionId: string): JobMatchAnalysisRecord[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM job_match_analysis_records WHERE candidate_version_id = ? ORDER BY created_at DESC, id DESC`)
      .all(candidateVersionId) as JobMatchAnalysisRecordRow[];
    return rows.map(rowToJobMatchAnalysisRecord);
  }
}

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

  /**
   * 幂等成功写入原语（设计 §9 步骤 3–4）：INSERT 新记录；命中 input_hash UNIQUE 冲突时
   * 复用既有记录，绝不插入第二份。返回生效记录与 created 标记。
   * 供执行器在原子成功写入事务内调用——同一 inputHash 只保留唯一正式结果（TD §3.3）。
   */
  insertOrGetByInputHash(record: JobMatchAnalysisRecord): { record: JobMatchAnalysisRecord; created: boolean } {
    try {
      this.insert(record);
      return { record, created: true };
    } catch (error) {
      const existing = this.findByInputHash(record.inputHash);
      // 仅 input_hash 冲突（已有同指纹记录）才是幂等复用路径；否则是真实写入错误，原样抛出。
      if (existing === null) throw error;
      return { record: existing, created: false };
    }
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

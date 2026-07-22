import type { RadarRuleAssessment } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarRuleAssessmentToParams,
  rowToRadarRuleAssessment,
  type RadarRuleAssessmentRow,
} from './rowMappers';

const COLUMNS = `
  id, candidate_id, candidate_version_id, rule_version, rule_key, category,
  severity, result, matched_text, source_path, explanation, evidence_json, created_at
`;

/**
 * 规则评估追加写入。每次评估针对固定 candidate_version_id，不做 update。
 * evidence_json 是 V8-3/RC-06 权威证据结构（BR-2 方案 A）：新行写入合法 evidence_json，
 * 旧行为 NULL；同时保留 matched_text/source_path/explanation 摘要字段用于兼容读取。
 */
export class RadarRuleAssessmentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(assessment: RadarRuleAssessment): void {
    this.db.prepare(`
      INSERT INTO radar_rule_assessments (
        id, candidate_id, candidate_version_id, rule_version, rule_key, category,
        severity, result, matched_text, source_path, explanation, evidence_json, created_at
      ) VALUES (
        @id, @candidateId, @candidateVersionId, @ruleVersion, @ruleKey, @category,
        @severity, @result, @matchedText, @sourcePath, @explanation, @evidenceJson, @createdAt
      )
    `).run(radarRuleAssessmentToParams(assessment));
  }

  listByCandidateVersion(candidateVersionId: string): RadarRuleAssessment[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_rule_assessments WHERE candidate_version_id = ? ORDER BY created_at, id`)
      .all(candidateVersionId) as RadarRuleAssessmentRow[];
    return rows.map(rowToRadarRuleAssessment);
  }
}

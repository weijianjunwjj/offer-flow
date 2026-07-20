import type { RadarRuleAssessment } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarRuleAssessmentToParams,
  rowToRadarRuleAssessment,
  type RadarRuleAssessmentRow,
} from './rowMappers';

const COLUMNS = `
  id, candidate_id, candidate_version_id, rule_version, rule_key, category,
  severity, result, matched_text, source_path, explanation, created_at
`;

/** 规则评估追加写入。每次评估针对固定 candidate_version_id，不做 update。 */
export class RadarRuleAssessmentRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(assessment: RadarRuleAssessment): void {
    this.db.prepare(`
      INSERT INTO radar_rule_assessments (
        id, candidate_id, candidate_version_id, rule_version, rule_key, category,
        severity, result, matched_text, source_path, explanation, created_at
      ) VALUES (
        @id, @candidateId, @candidateVersionId, @ruleVersion, @ruleKey, @category,
        @severity, @result, @matchedText, @sourcePath, @explanation, @createdAt
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

import type { RadarRecommendationBatch } from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarRecommendationBatchToParams,
  rowToRadarRecommendationBatch,
  type RadarRecommendationBatchRow,
} from './rowMappers';

const COLUMNS = `
  id, batch_key, status, scope_json, candidate_version_ids_json,
  selected_candidate_version_ids_json, profile_versions_json, rule_version,
  recommendation_rule_version, analysis_policy_version, handled_state_hash,
  diagnosis_status, diagnosis_payload_json, empty_reason, generated_at, created_at
`;

/** 推荐批次基础读写。batch_key 唯一约束由 DB 层保证幂等（TD §13.3）。 */
export class RadarRecommendationBatchRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insert(batch: RadarRecommendationBatch): void {
    this.db.prepare(`
      INSERT INTO radar_recommendation_batches (
        id, batch_key, status, scope_json, candidate_version_ids_json,
        selected_candidate_version_ids_json, profile_versions_json, rule_version,
        recommendation_rule_version, analysis_policy_version, handled_state_hash,
        diagnosis_status, diagnosis_payload_json, empty_reason, generated_at, created_at
      ) VALUES (
        @id, @batchKey, @status, @scopeJson, @candidateVersionIdsJson,
        @selectedCandidateVersionIdsJson, @profileVersionsJson, @ruleVersion,
        @recommendationRuleVersion, @analysisPolicyVersion, @handledStateHash,
        @diagnosisStatus, @diagnosisPayloadJson, @emptyReason, @generatedAt, @createdAt
      )
    `).run(radarRecommendationBatchToParams(batch));
  }

  getById(id: string): RadarRecommendationBatch | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_recommendation_batches WHERE id = ?`)
      .get(id) as RadarRecommendationBatchRow | undefined;
    return row === undefined ? null : rowToRadarRecommendationBatch(row);
  }

  findByBatchKey(batchKey: string): RadarRecommendationBatch | null {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_recommendation_batches WHERE batch_key = ?`)
      .get(batchKey) as RadarRecommendationBatchRow | undefined;
    return row === undefined ? null : rowToRadarRecommendationBatch(row);
  }

  listRecent(limit: number): RadarRecommendationBatch[] {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM radar_recommendation_batches ORDER BY generated_at DESC, id DESC LIMIT ?`)
      .all(limit) as RadarRecommendationBatchRow[];
    return rows.map(rowToRadarRecommendationBatch);
  }
}

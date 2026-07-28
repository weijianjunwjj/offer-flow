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

  /**
   * 反向追踪（RC-11）：找出 scope 内包含某候选版本的批次。
   *
   * 这**不是**晋升到批次的因果外键（晋升表不存 batch_id，两者无直接关联），
   * 而是"哪些批次的 scope 覆盖过该候选版本"的成员关系推断——调用方必须据此如实标注，
   * 不得伪造成因果来源。用 json_each 展开 candidate_version_ids_json（原始 scope，
   * 而非 selected_*：被排除的候选也算被该批次覆盖过）。
   */
  listByCandidateVersionMembership(candidateVersionId: string): RadarRecommendationBatch[] {
    const rows = this.db
      .prepare(`
        SELECT ${COLUMNS} FROM radar_recommendation_batches
        WHERE EXISTS (
          SELECT 1 FROM json_each(candidate_version_ids_json) WHERE json_each.value = ?
        )
        ORDER BY generated_at DESC, id DESC
      `)
      .all(candidateVersionId) as RadarRecommendationBatchRow[];
    return rows.map(rowToRadarRecommendationBatch);
  }
}

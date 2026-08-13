import type {
  RadarCandidate,
  RadarCandidateSourceLink,
  RadarCandidateVersion,
} from '../../src/domain/radar';
import type { SqliteDatabase } from '../db';
import {
  radarCandidateSourceLinkToParams,
  radarCandidateToParams,
  radarCandidateVersionToParams,
  rowToRadarCandidate,
  rowToRadarCandidateSourceLink,
  rowToRadarCandidateVersion,
  type RadarCandidateRow,
  type RadarCandidateSourceLinkRow,
  type RadarCandidateVersionRow,
} from './rowMappers';

const CANDIDATE_COLUMNS = `
  id, primary_source_record_id, active_version_id, lifecycle_status,
  merged_into_candidate_id, created_at, updated_at
`;

const VERSION_COLUMNS = `
  id, candidate_id, version_no, normalized_json, quality_issues_json,
  source_snapshot_ids_json, content_hash, origin_type, evidence_level,
  correction_note, supersedes_version_id, created_at
`;

/**
 * Candidate 与 CandidateVersion 基础读写。
 * CandidateVersion 只提供 insert，不提供任何 update：纠错/来源变化通过创建新版本表达（TD §4.5）。
 * Candidate 允许 insertWithoutActiveVersion + setActiveVersionId 两步，配合调用方事务，
 * 解决 candidates.active_version_id ↔ candidate_versions.candidate_id 的循环外键。
 */
export class RadarCandidateRepository {
  constructor(private readonly db: SqliteDatabase) {}

  insertCandidate(candidate: RadarCandidate): void {
    this.db.prepare(`
      INSERT INTO radar_candidates (
        id, primary_source_record_id, active_version_id, lifecycle_status,
        merged_into_candidate_id, created_at, updated_at
      ) VALUES (
        @id, @primarySourceRecordId, @activeVersionId, @lifecycleStatus,
        @mergedIntoCandidateId, @createdAt, @updatedAt
      )
    `).run(radarCandidateToParams(candidate));
  }

  getCandidate(id: string): RadarCandidate | null {
    const row = this.db
      .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM radar_candidates WHERE id = ?`)
      .get(id) as RadarCandidateRow | undefined;
    return row === undefined ? null : rowToRadarCandidate(row);
  }

  findByPrimarySourceRecordId(sourceRecordId: string): RadarCandidate | null {
    const row = this.db
      .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM radar_candidates WHERE primary_source_record_id = ?`)
      .get(sourceRecordId) as RadarCandidateRow | undefined;
    return row === undefined ? null : rowToRadarCandidate(row);
  }

  listActiveCandidates(): RadarCandidate[] {
    const rows = this.db
      .prepare(`SELECT ${CANDIDATE_COLUMNS} FROM radar_candidates WHERE lifecycle_status = 'active' ORDER BY updated_at DESC, id`)
      .all() as RadarCandidateRow[];
    return rows.map(rowToRadarCandidate);
  }

  setActiveVersionId(candidateId: string, activeVersionId: string, updatedAt: number): boolean {
    const result = this.db.prepare(`
      UPDATE radar_candidates SET active_version_id = @activeVersionId, updated_at = @updatedAt WHERE id = @candidateId
    `).run({ candidateId, activeVersionId, updatedAt });
    return result.changes === 1;
  }

  setLifecycleStatus(
    candidateId: string,
    lifecycleStatus: RadarCandidate['lifecycleStatus'],
    mergedIntoCandidateId: string | null,
    updatedAt: number,
  ): boolean {
    const result = this.db.prepare(`
      UPDATE radar_candidates
      SET lifecycle_status = @lifecycleStatus, merged_into_candidate_id = @mergedIntoCandidateId, updated_at = @updatedAt
      WHERE id = @candidateId
    `).run({ candidateId, lifecycleStatus, mergedIntoCandidateId, updatedAt });
    return result.changes === 1;
  }

  insertVersion(version: RadarCandidateVersion): void {
    this.db.prepare(`
      INSERT INTO radar_candidate_versions (
        id, candidate_id, version_no, normalized_json, quality_issues_json,
        source_snapshot_ids_json, content_hash, origin_type, evidence_level,
        correction_note, supersedes_version_id, created_at
      ) VALUES (
        @id, @candidateId, @versionNo, @normalizedJson, @qualityIssuesJson,
        @sourceSnapshotIdsJson, @contentHash, @originType, @evidenceLevel,
        @correctionNote, @supersedesVersionId, @createdAt
      )
    `).run(radarCandidateVersionToParams(version));
  }

  getVersion(id: string): RadarCandidateVersion | null {
    const row = this.db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM radar_candidate_versions WHERE id = ?`)
      .get(id) as RadarCandidateVersionRow | undefined;
    return row === undefined ? null : rowToRadarCandidateVersion(row);
  }

  listVersionsByCandidate(candidateId: string): RadarCandidateVersion[] {
    const rows = this.db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM radar_candidate_versions WHERE candidate_id = ? ORDER BY version_no DESC`)
      .all(candidateId) as RadarCandidateVersionRow[];
    return rows.map(rowToRadarCandidateVersion);
  }

  findVersionByContentHash(candidateId: string, contentHash: string): RadarCandidateVersion | null {
    const row = this.db
      .prepare(`SELECT ${VERSION_COLUMNS} FROM radar_candidate_versions WHERE candidate_id = ? AND content_hash = ?`)
      .get(candidateId, contentHash) as RadarCandidateVersionRow | undefined;
    return row === undefined ? null : rowToRadarCandidateVersion(row);
  }

  nextVersionNo(candidateId: string): number {
    const row = this.db
      .prepare('SELECT MAX(version_no) AS maxVersionNo FROM radar_candidate_versions WHERE candidate_id = ?')
      .get(candidateId) as { maxVersionNo: number | null };
    return (row.maxVersionNo ?? 0) + 1;
  }

  linkSource(link: RadarCandidateSourceLink): void {
    this.db.prepare(`
      INSERT INTO radar_candidate_sources (
        candidate_id, source_record_id, first_linked_at, last_confirmed_at, link_reason
      ) VALUES (
        @candidateId, @sourceRecordId, @firstLinkedAt, @lastConfirmedAt, @linkReason
      )
      ON CONFLICT(candidate_id, source_record_id) DO UPDATE SET
        last_confirmed_at = excluded.last_confirmed_at,
        link_reason = excluded.link_reason
    `).run(radarCandidateSourceLinkToParams(link));
  }

  listSourceLinks(candidateId: string): RadarCandidateSourceLink[] {
    const rows = this.db
      .prepare(`
        SELECT candidate_id, source_record_id, first_linked_at, last_confirmed_at, link_reason
        FROM radar_candidate_sources WHERE candidate_id = ? ORDER BY first_linked_at
      `)
      .all(candidateId) as RadarCandidateSourceLinkRow[];
    return rows.map(rowToRadarCandidateSourceLink);
  }
}

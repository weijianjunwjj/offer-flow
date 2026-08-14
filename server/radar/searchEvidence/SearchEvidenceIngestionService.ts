/**
 * v0.9 Phase 2 — Search Evidence Ingestion Service.
 *
 * 提供独立于 Browser Capture session 的 search_discovery snapshot 写入路径。
 *
 * 关键差异 vs RadarCaptureService.materializeItem():
 *   - 不经过 CaptureSession / PreviewItem 模型（captureSessionId = null）
 *   - 不经过 commitSession 事务（每条 search evidence 独立摄入）
 *   - captureMethod = 'search_discovery'
 *   - evidenceLevel 由调用方指定（初始 SEARCH_EVIDENCE），不默认为 FULL_EVIDENCE
 *   - 复用相同的 identity resolution / normalization / decideCommit / insertNewVersion 链
 *
 * 约束：
 *   - 不实现 Content Acquisition（Phase 4）
 *   - 不实现 Source Policy 判定（Phase 4）
 *   - analysisEligible 由 commitDecision 的 evidenceLevel gate 控制（Phase 2 hardening）
 *     SEARCH_EVIDENCE / MANUAL_REVIEW_REQUIRED → analysisEligible = false
 *   - 不在此 service 中调用 AnalysisService.createTask() 或 RecommendationBatch
 *
 * 设计依据：specs/001-daily-job-hunter/tasks.md T018
 */

import type { SqliteDatabase } from '../../db';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarCaptureRepository } from '../captureRepository';
import { RadarSourceRecordRepository } from '../sourceRecordRepository';
import { decideCommit } from '../commitDecision';
import { normalizeCandidateFields } from '../fieldNormalization';
import { normalizeSourceUrl } from '../normalize';
import { resolveIdentity } from '../identityResolution';
import { sha256RequestHash } from '../../job-memory/requestHash';
import type {
  RadarCandidate,
  RadarCandidateNormalized,
  RadarCandidateVersion,
  RadarCaptureSnapshot,
  RadarEvidenceLevel,
  RadarSourceRecord,
} from '../../../src/domain/radar';
import type { SearchEvidenceItem } from './searchEvidenceTypes';
import { extractDomain } from './searchEvidenceTypes';
import type { CommitDecisionSummary } from '../candidateChangeSet';
import { isUniqueConstraintViolation } from '../uniqueViolation';

export interface SearchEvidenceIngestionDeps {
  now: () => number;
  createId: () => string;
}

export interface SearchEvidenceIngestionOutcome {
  snapshotId: string;
  candidateId: string | null;
  candidateVersionId: string | null;
  sourceRecordId: string | null;
  evidenceLevel: string;
  decisionType: string;
  analysisEligible: boolean;
  decision: CommitDecisionSummary;
}

export class SearchEvidenceIngestionService {
  private readonly captures: RadarCaptureRepository;
  private readonly sourceRecords: RadarSourceRecordRepository;
  private readonly candidates: RadarCandidateRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: SearchEvidenceIngestionDeps,
  ) {
    this.captures = new RadarCaptureRepository(db);
    this.sourceRecords = new RadarSourceRecordRepository(db);
    this.candidates = new RadarCandidateRepository(db);
  }

  /**
   * 摄入单条 Search Evidence。
   *
   * 全程在单一事务内执行：snapshot 写入 → 标准化 → identity resolution →
   * 材料变化判定 → Candidate/Version 创建（或不创建）。
   */
  ingest(item: SearchEvidenceItem, evidenceLevel: RadarEvidenceLevel): SearchEvidenceIngestionOutcome {
    const now = this.deps.now();

    return this.db.transaction(() => {
      // (1) Build snapshot — captureSessionId = null, captureMethod = 'search_discovery'
      const snapshot = this.buildSearchSnapshot(item, now);
      this.captures.insertSnapshot(snapshot);

      // (2) Deterministic normalization from search evidence fields
      const norm = normalizeCandidateFields({
        recognizedFields: {
          company: null,
          role: item.title,
          city: null,
          salaryMinK: null,
          salaryMaxK: null,
          salaryPeriod: null,
          experienceRequirement: null,
          educationRequirement: null,
        },
        rawDescription: item.content,
      });

      // (3) Exact identity (provider-aware; multi-hit → identity_conflict)
      const identity = resolveIdentity(
        {
          providerKey: item.provider,
          externalRecordId: item.url,
          sourceUrl: item.url,
        },
        {
          findByProviderKey: (pk, ext) => this.sourceRecords.findByProviderKey(pk, ext),
          findAllByProviderAndUrl: (pk, url) => this.sourceRecords.findAllByProviderAndUrl(pk, url),
        },
      );

      // (4) Load existing active version
      const existingSourceRecord = identity.matched;
      const existingCandidate = existingSourceRecord === null
        ? null
        : this.candidates.findByPrimarySourceRecordId(existingSourceRecord.id);
      const previousVersion = existingCandidate !== null && existingCandidate.activeVersionId !== null
        ? this.candidates.getVersion(existingCandidate.activeVersionId)
        : null;

      // (5)+(6) Fingerprint + material change → decision
      const decided = decideCommit({
        identity,
        previousNormalized: previousVersion?.normalized ?? null,
        nextNormalized: norm.normalized,
        ambiguousFields: norm.ambiguousFields,
        snapshotId: snapshot.id,
        // v0.9 Phase 2：Search Evidence 携带真实 evidenceLevel →
        // decideCommit 的 evidenceLevel gate 决定 analysisEligible
        evidenceLevel,
      });
      const decisionType = decided.summary.decisionType;

      const baseOutcome = (): SearchEvidenceIngestionOutcome => ({
        snapshotId: snapshot.id,
        candidateId: existingCandidate?.id ?? null,
        candidateVersionId: existingCandidate?.activeVersionId ?? null,
        sourceRecordId: existingSourceRecord?.id ?? null,
        evidenceLevel,
        decisionType,
        analysisEligible: decided.summary.analysisEligible,
        decision: decided.summary,
      });

      // (7) identity_conflict: snapshot only, no candidate/version
      if (decisionType === 'identity_conflict') {
        return { ...baseOutcome(), candidateId: null, candidateVersionId: null, sourceRecordId: null };
      }

      // Existing source: refresh last_seen
      if (existingSourceRecord !== null) {
        const changed = decisionType === 'material_change';
        this.sourceRecords.updateLatestSnapshot(
          existingSourceRecord.id, snapshot.id, now,
          changed ? now : existingSourceRecord.lastChangedAt, now,
        );
      }

      // Existing candidate: only material_change creates new version
      if (existingCandidate !== null && previousVersion !== null) {
        if (decisionType === 'material_change') {
          const version = this.insertNewVersion(
            existingCandidate, norm.normalized, decided.fingerprint,
            [snapshot.id], now, 'source_change', evidenceLevel,
          );
          return { ...baseOutcome(), candidateVersionId: version.id };
        }
        return baseOutcome();
      }

      // New identity: create source record + candidate + first version
      const sourceRecord: RadarSourceRecord = existingSourceRecord ?? {
        id: this.deps.createId(),
        providerKey: item.provider,
        externalRecordId: item.url,
        normalizedSourceUrl: identity.canonicalSourceUrl ?? normalizeSourceUrl(item.url),
        firstSeenAt: now,
        lastSeenAt: now,
        lastChangedAt: null,
        latestSnapshotId: snapshot.id,
        sourceStatus: 'active',
        createdAt: now,
        updatedAt: now,
      };
      if (existingSourceRecord === null) this.sourceRecords.insert(sourceRecord);

      const candidate: RadarCandidate = {
        id: this.deps.createId(),
        primarySourceRecordId: sourceRecord.id,
        activeVersionId: null,
        lifecycleStatus: 'active',
        createdAt: now,
        updatedAt: now,
        mergedIntoCandidateId: null,
      };
      this.candidates.insertCandidate(candidate);
      const version = this.insertNewVersion(
        candidate, norm.normalized, decided.fingerprint,
        [snapshot.id], now, 'captured', evidenceLevel,
      );
      this.candidates.linkSource({
        candidateId: candidate.id,
        sourceRecordId: sourceRecord.id,
        firstLinkedAt: now,
        lastConfirmedAt: now,
        linkReason: 'primary',
      });

      return {
        ...baseOutcome(),
        candidateId: candidate.id,
        candidateVersionId: version.id,
        sourceRecordId: sourceRecord.id,
      };
    })();
  }

  /**
   * Build an immutable snapshot from Search Evidence (no capture session).
   */
  private buildSearchSnapshot(item: SearchEvidenceItem, now: number): RadarCaptureSnapshot {
    const sourceUrl = item.url;
    const normalizedUrl = normalizeSourceUrl(sourceUrl);
    const domain = item.domain || extractDomain(sourceUrl);
    const rawContentHash = sha256RequestHash({
      captureMethod: 'search_discovery',
      sourceUrl: normalizedUrl,
      visibleText: item.content,
    });

    return {
      id: this.deps.createId(),
      captureSessionId: null,
      captureMethod: 'search_discovery',
      providerKey: item.provider,
      providerVersion: null,
      sourceDomain: domain,
      sourceUrl,
      normalizedSourceUrl: normalizedUrl,
      externalRecordId: item.url,
      pageTitle: item.title,
      visibleText: item.content,
      rawSnapshot: {
        provider: item.provider,
        query: item.query,
        providerScore: item.providerScore ?? null,
        providerRequestId: item.providerRequestId ?? null,
        providerMetadata: item.providerMetadata ?? null,
        publishedAt: item.publishedAt ?? null,
        searchedAt: item.searchedAt,
      },
      rawContentHash,
      capturedAt: item.searchedAt || now,
      createdAt: now,
    };
  }

  private insertNewVersion(
    candidate: RadarCandidate,
    normalized: RadarCandidateNormalized,
    contentHash: string,
    sourceSnapshotIds: string[],
    now: number,
    originType: 'captured' | 'source_change',
    evidenceLevel: RadarEvidenceLevel,
  ): RadarCandidateVersion {
    // Historical version reactivation：material change 提交前先查 (candidate_id, content_hash)。
    // 若历史已存在同 hash 版本（如 A→B→A 回退），复用并切回 active，绝不 INSERT 重复版本，
    // 否则会命中 UNIQUE(candidate_id, content_hash) 导致整条摄入失败。
    const historical = this.candidates.findVersionByContentHash(candidate.id, contentHash);
    if (historical !== null) {
      this.candidates.setActiveVersionId(candidate.id, historical.id, now);
      return historical;
    }

    const version: RadarCandidateVersion = {
      id: this.deps.createId(),
      candidateId: candidate.id,
      versionNo: this.candidates.nextVersionNo(candidate.id),
      normalized,
      qualityIssues: [],
      sourceSnapshotIds,
      contentHash,
      originType,
      evidenceLevel,
      correctionNote: null,
      supersedesVersionId: candidate.activeVersionId,
      createdAt: now,
    };
    try {
      this.candidates.insertVersion(version);
    } catch (error) {
      // 并发兜底：仅当 UNIQUE(candidate_id, content_hash) 竞争时复用已存在版本；
      // 其它约束 / DB 错误继续向上抛出，不得被误吞。
      if (isUniqueConstraintViolation(error)) {
        const existing = this.candidates.findVersionByContentHash(candidate.id, contentHash);
        if (existing !== null) {
          this.candidates.setActiveVersionId(candidate.id, existing.id, now);
          return existing;
        }
      }
      throw error;
    }
    this.candidates.setActiveVersionId(candidate.id, version.id, now);
    return version;
  }
}

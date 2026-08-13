/**
 * v0.9 Phase 5A — Evidence Upgrade Persistence Service。
 *
 * 职责：validated Content Acquisition result + existing SEARCH_EVIDENCE version identity
 *      → 显式 evidence_upgrade → 新的 FULL_EVIDENCE CandidateVersion。
 *
 * 设计依据：Phase 5A Implementation Scope Lock v3 + Idempotency / Stale Ordering Amendment。
 *
 * 硬边界（本 service 不越界）：
 *   - fetch success != FULL_EVIDENCE；validation PASS != FULL_EVIDENCE；
 *     本 service 只接收已通过验证的 content + validation，FULL_EVIDENCE 由 service 固定产生。
 *   - evidence_upgrade 是版本事件（创建新不可变 CandidateVersion），不是字段覆写；
 *     原 SEARCH_EVIDENCE 版本绝不 UPDATE。
 *   - 不实现 Content Acquisition / Analysis / Recommendation / Pipeline / Scheduler。
 *   - 不新建 DB migration / schema，不新增 runtime dependency。
 *
 * 幂等 / stale 判断顺序严格冻结（upgrade 方法内注释编号 1–13）。
 */

import type { SqliteDatabase } from '../../db';
import { RadarCandidateRepository } from '../candidateRepository';
import { RadarCaptureRepository } from '../captureRepository';
import { RadarSourceRecordRepository } from '../sourceRecordRepository';
import { getSourcePolicyDecision } from '../sourcePolicy/sourcePolicy';
import { normalizeSourceUrl } from '../normalize';
import { sha256RequestHash } from '../../job-memory/requestHash';
import { isEvidenceUpgradeEligible } from '../../content-acquisition/types';
import type {
  RadarCandidate,
  RadarCandidateNormalized,
  RadarCandidateVersion,
  RadarCaptureSnapshot,
} from '../../../src/domain/radar';
import { computeEvidenceUpgradeContentHash } from './evidenceUpgradeHash';
import type {
  EvidenceUpgradeBlockReason,
  EvidenceUpgradeFailReason,
  EvidenceUpgradeInput,
  EvidenceUpgradeResult,
} from './types';

export interface EvidenceUpgradeDeps {
  now: () => number;
  createId: () => string;
}

/** better-sqlite3 的 UNIQUE 约束违反（含并发兜底重放路径）识别。 */
function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  return /UNIQUE constraint failed/i.test(error.message);
}

export class EvidenceUpgradeService {
  private readonly candidates: RadarCandidateRepository;
  private readonly captures: RadarCaptureRepository;
  private readonly sourceRecords: RadarSourceRecordRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: EvidenceUpgradeDeps,
  ) {
    this.candidates = new RadarCandidateRepository(db);
    this.captures = new RadarCaptureRepository(db);
    this.sourceRecords = new RadarSourceRecordRepository(db);
  }

  upgrade(input: EvidenceUpgradeInput): EvidenceUpgradeResult {
    // 1) validation eligibility
    if (!isEvidenceUpgradeEligible(input.validation)) {
      return this.blocked('validation_not_eligible');
    }

    // 2) load source version
    const sourceVersion = this.candidates.getVersion(input.sourceVersionId);
    if (sourceVersion === null) {
      return this.blocked('source_version_not_found');
    }

    // 3) source evidence level 必须是 SEARCH_EVIDENCE
    if (sourceVersion.evidenceLevel !== 'SEARCH_EVIDENCE') {
      return this.blocked('invalid_source_evidence_level');
    }

    // 4) load candidate + lifecycle
    const candidate = this.candidates.getCandidate(sourceVersion.candidateId);
    if (candidate === null) {
      return this.blocked('candidate_not_found');
    }
    if (candidate.lifecycleStatus !== 'active') {
      return this.blocked('candidate_not_active');
    }

    // 5) derive source snapshot / URL（不信任调用方 URL）
    const sourceSnapshot = this.resolveSourceSnapshot(sourceVersion);
    const realSourceUrl = sourceSnapshot === null
      ? null
      : sourceSnapshot.sourceUrl ?? sourceSnapshot.normalizedSourceUrl;
    if (sourceSnapshot === null || realSourceUrl === null || realSourceUrl.trim() === '') {
      return this.blocked('source_url_unresolvable');
    }

    // 6) Source Policy revalidation（从真实 snapshot URL 重新判定，不建第二份 allowlist）
    const policy = getSourcePolicyDecision(realSourceUrl);
    if (
      policy.policy !== 'SEARCH_AND_FETCH'
      || policy.fetchEligible !== true
      || policy.targetEvidenceLevelAfterFetch !== 'FULL_EVIDENCE'
    ) {
      return this.blocked('source_policy_blocked');
    }

    // 7) derive upgradedNormalized（继承 + 证据增强；content.title 不覆盖 role）
    const upgradedNormalized: RadarCandidateNormalized = {
      ...sourceVersion.normalized,
      rawDescription: input.content.plainText,
    };

    // 8) compute upgrade content hash
    const newHash = computeEvidenceUpgradeContentHash(upgradedNormalized);

    // 9) detect existing evidence_upgrade child（source-level，按三条件而非 contentHash）
    const children = this.findChildren(sourceVersion);
    if (children.length > 1) {
      return this.failed('version_chain_invariant_violation');
    }
    const existingChild = children[0] ?? null;

    // 10) existing-child idempotency branch
    if (existingChild !== null) {
      return this.existingChildResult(existingChild, newHash, sourceVersion.candidateId);
    }

    // 11) candidate-level same-content branch
    const sameContent = this.candidates.findVersionByContentHash(sourceVersion.candidateId, newHash);
    if (sameContent !== null) {
      return this.sameContentResult(sameContent, sourceVersion.candidateId);
    }

    // 12) true stale check（只有无 child 且无合法 candidate-level ALREADY 后才判断）
    if (candidate.activeVersionId !== sourceVersion.id) {
      return this.blocked('stale_source_version');
    }

    // 13) transaction write（内部二次 re-check，防 TOCTOU）
    return this.writeUpgrade(input.content, sourceVersion, sourceSnapshot, upgradedNormalized, newHash);
  }

  // ── 结果构造 ────────────────────────────────────────────────────────────────

  private blocked(reasonCode: EvidenceUpgradeBlockReason): EvidenceUpgradeResult {
    return { status: 'BLOCKED', reasonCode };
  }

  private failed(reasonCode: EvidenceUpgradeFailReason): EvidenceUpgradeResult {
    return { status: 'FAILED', reasonCode };
  }

  private existingChildResult(
    child: RadarCandidateVersion,
    newHash: string,
    candidateId: string,
  ): EvidenceUpgradeResult {
    if (child.contentHash === newHash) {
      return { status: 'ALREADY_UPGRADED', existingVersionId: child.id, candidateId };
    }
    return this.blocked('source_already_upgraded_content_changed');
  }

  private sameContentResult(
    version: RadarCandidateVersion,
    candidateId: string,
  ): EvidenceUpgradeResult {
    // 仅当已有版本是 evidence_upgrade + FULL_EVIDENCE 才视为幂等成功；
    // 其他 originType 的同 hash 命中是 content collision，不静默当作升级成功。
    if (version.originType === 'evidence_upgrade' && version.evidenceLevel === 'FULL_EVIDENCE') {
      return { status: 'ALREADY_UPGRADED', existingVersionId: version.id, candidateId };
    }
    return this.failed('content_hash_collision');
  }

  // ── lineage 查找 ────────────────────────────────────────────────────────────

  private findChildren(sourceVersion: RadarCandidateVersion): RadarCandidateVersion[] {
    return this.candidates.listVersionsByCandidate(sourceVersion.candidateId).filter(
      (v) => v.originType === 'evidence_upgrade' && v.supersedesVersionId === sourceVersion.id,
    );
  }

  /** 从 sourceVersion.sourceSnapshotIds 读取真实 search_discovery snapshot；无则 null。 */
  private resolveSourceSnapshot(sourceVersion: RadarCandidateVersion): RadarCaptureSnapshot | null {
    const snapshots = sourceVersion.sourceSnapshotIds
      .map((id) => this.captures.getSnapshot(id))
      .filter((s): s is RadarCaptureSnapshot => s !== null);
    const searchSnapshot = snapshots.find((s) => s.captureMethod === 'search_discovery');
    return searchSnapshot ?? snapshots[0] ?? null;
  }

  // ── 写入 ────────────────────────────────────────────────────────────────────

  private writeUpgrade(
    content: EvidenceUpgradeInput['content'],
    sourceVersion: RadarCandidateVersion,
    sourceSnapshot: RadarCaptureSnapshot,
    upgradedNormalized: RadarCandidateNormalized,
    newHash: string,
  ): EvidenceUpgradeResult {
    const candidateId = sourceVersion.candidateId;

    try {
      // BEGIN IMMEDIATE：transaction 起始即获取写锁，使 re-check → insert → activeVersion 串行化，
      // 避免 TOCTOU。better-sqlite3 原生 primitive，不新增依赖 / 不修改 DB 基础设施。
      return this.db.transaction(() => {
        // 事务内二次 re-check（不信任外层 fast-path 结果）
        const freshCandidate = this.candidates.getCandidate(candidateId);
        if (freshCandidate === null) {
          return this.blocked('candidate_not_found');
        }

        const children = this.findChildren(sourceVersion);
        if (children.length > 1) {
          return this.failed('version_chain_invariant_violation');
        }
        if (children.length === 1) {
          return this.existingChildResult(children[0], newHash, candidateId);
        }

        const sameContent = this.candidates.findVersionByContentHash(candidateId, newHash);
        if (sameContent !== null) {
          return this.sameContentResult(sameContent, candidateId);
        }

        if (freshCandidate.activeVersionId !== sourceVersion.id) {
          return this.blocked('stale_source_version');
        }

        // 真正写入
        const now = this.deps.now();
        const snapshot = this.buildUpgradeSnapshot(sourceSnapshot, content, now);
        this.captures.insertSnapshot(snapshot);
        const version = this.insertUpgradeVersion(
          freshCandidate, sourceVersion, upgradedNormalized, newHash, snapshot.id, now,
        );
        if (freshCandidate.primarySourceRecordId !== null) {
          this.sourceRecords.updateLatestSnapshot(
            freshCandidate.primarySourceRecordId, snapshot.id, now, now, now,
          );
        }

        return {
          status: 'UPGRADED',
          versionId: version.id,
          snapshotId: snapshot.id,
          candidateId,
        } as const;
      }).immediate();
    } catch (error) {
      // UNIQUE(candidate_id, content_hash) 并发兜底：事务已整体回滚（无部分写入），重读已存在版本。
      if (isUniqueConstraintViolation(error)) {
        const existing = this.candidates.findVersionByContentHash(candidateId, newHash);
        if (
          existing !== null
          && existing.originType === 'evidence_upgrade'
          && existing.evidenceLevel === 'FULL_EVIDENCE'
        ) {
          return { status: 'ALREADY_UPGRADED', existingVersionId: existing.id, candidateId };
        }
        return this.failed('content_hash_collision');
      }
      throw error;
    }
  }

  private buildUpgradeSnapshot(
    sourceSnapshot: RadarCaptureSnapshot,
    content: EvidenceUpgradeInput['content'],
    now: number,
  ): RadarCaptureSnapshot {
    const normalizedUrl = normalizeSourceUrl(sourceSnapshot.sourceUrl) ?? sourceSnapshot.normalizedSourceUrl;
    const rawContentHash = sha256RequestHash({
      captureMethod: 'open_web_fetch',
      sourceUrl: normalizedUrl,
      visibleText: content.plainText,
    });

    return {
      id: this.deps.createId(),
      captureSessionId: null,
      captureMethod: 'open_web_fetch',
      providerKey: sourceSnapshot.providerKey,
      providerVersion: sourceSnapshot.providerVersion,
      sourceDomain: sourceSnapshot.sourceDomain,
      sourceUrl: sourceSnapshot.sourceUrl,
      normalizedSourceUrl: normalizedUrl,
      externalRecordId: sourceSnapshot.externalRecordId,
      pageTitle: content.title,
      visibleText: content.plainText,
      // 只保存有界 acquisition metadata；绝不保存 raw HTML / raw_content。
      rawSnapshot: {
        canonicalUrl: content.canonicalUrl,
        contentType: content.contentType,
      },
      rawContentHash,
      capturedAt: now,
      createdAt: now,
    };
  }

  private insertUpgradeVersion(
    candidate: RadarCandidate,
    sourceVersion: RadarCandidateVersion,
    upgradedNormalized: RadarCandidateNormalized,
    contentHash: string,
    snapshotId: string,
    now: number,
  ): RadarCandidateVersion {
    const version: RadarCandidateVersion = {
      id: this.deps.createId(),
      candidateId: candidate.id,
      versionNo: this.candidates.nextVersionNo(candidate.id),
      normalized: upgradedNormalized,
      qualityIssues: [],
      sourceSnapshotIds: [snapshotId],
      contentHash,
      originType: 'evidence_upgrade',
      evidenceLevel: 'FULL_EVIDENCE',
      correctionNote: null,
      supersedesVersionId: sourceVersion.id,
      createdAt: now,
    };
    this.candidates.insertVersion(version);
    this.candidates.setActiveVersionId(candidate.id, version.id, now);
    return version;
  }
}

import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type {
  RadarCandidate,
  RadarCandidateNormalized,
  RadarCandidateVersion,
  RadarCaptureSession,
  RadarCaptureSnapshot,
  RadarSourceRecord,
} from '../../src/domain/radar';
import { sha256RequestHash } from '../job-memory/requestHash';
import type { SqliteDatabase } from '../db';
import { RadarCaptureRepository } from './captureRepository';
import { RadarSourceRecordRepository } from './sourceRecordRepository';
import { RadarCandidateRepository } from './candidateRepository';
import {
  radarCommitConflict,
  radarItemIndexNotFound,
  radarSessionExpired,
  radarSessionNotDraftable,
  radarSessionNotFound,
  radarTooManyItems,
  radarValidationError,
} from './errors';
import { normalizeSourceUrl } from './normalize';
import { normalizeCandidateFields } from './fieldNormalization';
import { resolveIdentity } from './identityResolution';
import { decideCommit } from './commitDecision';
import type { CommitDecisionSummary, CommitDecisionType } from './candidateChangeSet';
import { isUniqueConstraintViolation } from './uniqueViolation';
import {
  AddCaptureItemRequestSchema,
  CancelCaptureSessionRequestSchema,
  CommitCaptureSessionRequestSchema,
  CreateCaptureSessionRequestSchema,
  MAX_PREVIEW_ITEMS_PER_SESSION,
  RadarPreviewItemSchema,
  type AddCaptureItemRequest,
  type CommitCaptureSessionRequest,
  type RadarPreviewItem,
} from './dtoSchemas';

export { MAX_PREVIEW_ITEMS_PER_SESSION };

export interface RadarCaptureServiceDeps {
  now: () => number;
  createId: () => string;
}

/** 采集会话预览的默认存活时间：30 分钟，超时后需要拒绝写入并提示重新采集。 */
const SESSION_TTL_MS = 30 * 60 * 1000;

function parseDto<Output>(schema: z.ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) throw radarValidationError(result.error);
  return result.data;
}

export interface CaptureSessionView {
  session: RadarCaptureSession;
  items: RadarPreviewItem[];
}

export interface CommitOutcomeItem {
  index: number;
  /** identity_conflict / ambiguous / regression 等未落候选时可能为 null。 */
  candidateId: string | null;
  /** 未创建/未切换版本时为当前 active 版本或 null。 */
  candidateVersionId: string | null;
  sourceRecordId: string | null;
  snapshotId: string;
  /**
   * V8-2 兼容字段：created | unchanged | new_version。
   * 新增判定类型（snapshot_only/extraction_regression/ambiguous_change/identity_conflict）
   * 映射到最接近的兼容值（见 legacyKind），并由 decisionType 提供精确语义。
   */
  kind: 'created' | 'unchanged' | 'new_version';
  /** V8-3 精确决策类型。 */
  decisionType: CommitDecisionType;
  /** 是否具备后续分析资格（V8-4，本轮不触发）。 */
  analysisEligible: boolean;
  /** 结构化决策摘要（changedFields / needsConfirmation / blockingIssues / conflictReason）。 */
  decision: CommitDecisionSummary;
}

export interface CommitCaptureSessionResult {
  session: RadarCaptureSession;
  outcomes: CommitOutcomeItem[];
}

/** V8-2 兼容映射：把 V8-3 精确决策类型折算到旧 kind（created|unchanged|new_version）。 */
function legacyKind(decisionType: CommitDecisionType): CommitOutcomeItem['kind'] {
  switch (decisionType) {
    case 'new_identity':
      return 'created';
    case 'material_change':
      return 'new_version';
    // 未创建新版本的判定（无变化 / 仅快照 / 退化 / 待确认 / 冲突）对旧客户端表现为 unchanged。
    case 'no_change':
    case 'snapshot_only':
    case 'extraction_regression':
    case 'ambiguous_change':
    case 'identity_conflict':
      return 'unchanged';
  }
}

/**
 * V8-3 采集提交：preview → correction → commit，经确定性标准化、身份解析、fingerprint 与
 * 材料变化判定，产出不可变 CandidateVersion 决策。重复判定只用稳定来源身份 / provider-aware
 * canonical URL / 材料指纹，不做启发式相似度合并。
 */
export class RadarCaptureService {
  private readonly captures: RadarCaptureRepository;
  private readonly sourceRecords: RadarSourceRecordRepository;
  private readonly candidates: RadarCandidateRepository;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly deps: RadarCaptureServiceDeps = {
      now: Date.now,
      createId: randomUUID,
    },
  ) {
    this.captures = new RadarCaptureRepository(db);
    this.sourceRecords = new RadarSourceRecordRepository(db);
    this.candidates = new RadarCandidateRepository(db);
  }

  createSession(value: unknown): CaptureSessionView {
    const request = parseDto(CreateCaptureSessionRequestSchema, value);
    return this.transact(() => {
      const now = this.deps.now();
      const session: RadarCaptureSession = {
        id: this.deps.createId(),
        sourceType: request.sourceType,
        status: 'preview',
        rawInput: {},
        previewItems: [],
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        committedAt: null,
      };
      this.captures.insertSession(session);
      return { session, items: [] };
    });
  }

  getSessionView(sessionId: string): CaptureSessionView {
    const session = this.requireSession(sessionId);
    return { session, items: this.readItems(session) };
  }

  addItem(sessionId: string, value: unknown): CaptureSessionView {
    const request = parseDto(AddCaptureItemRequestSchema, value);
    return this.transact(() => {
      const session = this.requireDraftableSession(sessionId);
      const items = this.readItems(session);
      if (items.length >= MAX_PREVIEW_ITEMS_PER_SESSION) {
        throw radarTooManyItems(MAX_PREVIEW_ITEMS_PER_SESSION);
      }
      const now = this.deps.now();
      const item = this.buildPreviewItem(items.length, request, now);
      const nextItems = [...items, item];
      this.captures.updateSessionContent(sessionId, nextItems, nextItems);
      return { session, items: nextItems };
    });
  }

  cancelSession(sessionId: string, value: unknown): RadarCaptureSession {
    parseDto(CancelCaptureSessionRequestSchema, value);
    return this.transact(() => {
      const session = this.requireDraftableSession(sessionId);
      this.captures.updateSessionStatus(sessionId, 'cancelled', null);
      return { ...session, status: 'cancelled' };
    });
  }

  /**
   * commit 终态与幂等契约（Technical Design §4.1「commit 必须幂等」「committed session 不得再次生成重复快照」）：
   * - 首次成功 commit 后会话进入 committed 终态；
   * - 完全相同的重复 commit 直接重放首次结果（相同 Candidate/Version 等 ID、零新增行）；
   * - 内容不同的重复 commit 拒绝（COMMIT_CONFLICT）；
   * - preview 之外（cancelled/expired）的任何写操作拒绝。
   * 首次结果（请求指纹 + outcomes）存入既有 raw_input_json 列，不新增 schema。
   */
  commitSession(sessionId: string, value: unknown): CommitCaptureSessionResult {
    const request = parseDto(CommitCaptureSessionRequestSchema, value);
    const requestHash = sha256RequestHash({
      confirmedIndexes: request.confirmedIndexes,
      corrections: request.corrections,
    });
    return this.transact(() => {
      const session = this.requireSession(sessionId);
      if (session.status === 'committed') {
        const replay = this.readCommittedResult(session);
        if (replay !== null && replay.requestHash === requestHash) {
          return { session: this.publicSession(session), outcomes: replay.outcomes };
        }
        throw radarCommitConflict();
      }
      this.assertDraftable(session);
      const items = this.applyCorrections(this.readItems(session), request);
      const outcomes: CommitOutcomeItem[] = [];
      for (const index of request.confirmedIndexes) {
        const item = items.find((candidate) => candidate.index === index);
        if (item === undefined) throw radarItemIndexNotFound();
        outcomes.push(this.materializeItem(session.id, item));
      }
      const now = this.deps.now();
      this.captures.updateSessionContent(sessionId, { committedResult: { requestHash, outcomes } }, items);
      this.captures.updateSessionStatus(sessionId, 'committed', now);
      const committed: RadarCaptureSession = { ...session, status: 'committed', committedAt: now };
      return { session: this.publicSession(committed), outcomes };
    });
  }

  /** 返回给客户端的会话对象：清空内部存储用途的 rawInput，避免把 committedResult/预览镜像泄露到响应里。 */
  private publicSession(session: RadarCaptureSession): RadarCaptureSession {
    return { ...session, rawInput: {}, previewItems: [] };
  }

  private readCommittedResult(
    session: RadarCaptureSession,
  ): { requestHash: string; outcomes: CommitOutcomeItem[] } | null {
    const raw = session.rawInput;
    if (raw === null || typeof raw !== 'object') return null;
    const envelope = (raw as { committedResult?: unknown }).committedResult;
    if (envelope === null || typeof envelope !== 'object') return null;
    const { requestHash, outcomes } = envelope as { requestHash?: unknown; outcomes?: unknown };
    if (typeof requestHash !== 'string' || !Array.isArray(outcomes)) return null;
    return { requestHash, outcomes: outcomes as CommitOutcomeItem[] };
  }

  private buildPreviewItem(index: number, request: AddCaptureItemRequest, now: number): RadarPreviewItem {
    const capturedAt = request.capturedAt ?? now;
    const normalizedSourceUrl = normalizeSourceUrl(request.sourceUrl);
    const rawContentHash = sha256RequestHash({
      captureMethod: request.captureMethod,
      sourceUrl: normalizedSourceUrl,
      visibleText: request.visibleText,
    });
    return RadarPreviewItemSchema.parse({
      index,
      captureMethod: request.captureMethod,
      providerKey: request.providerKey,
      providerVersion: request.providerVersion,
      sourceUrl: request.sourceUrl,
      sourceDomain: request.sourceDomain,
      normalizedSourceUrl,
      pageTitle: request.pageTitle,
      visibleText: request.visibleText,
      externalRecordId: request.externalRecordId,
      recognizedFields: request.recognizedFields,
      extractionMetadata: request.extractionMetadata,
      correctionNote: null,
      capturedAt,
      rawContentHash,
    });
  }

  private applyCorrections(
    items: RadarPreviewItem[],
    request: CommitCaptureSessionRequest,
  ): RadarPreviewItem[] {
    if (request.corrections.length === 0) return items;
    const byIndex = new Map(items.map((item) => [item.index, item] as const));
    for (const correction of request.corrections) {
      const item = byIndex.get(correction.index);
      if (item === undefined) throw radarItemIndexNotFound();
      byIndex.set(correction.index, RadarPreviewItemSchema.parse({
        ...item,
        recognizedFields: correction.recognizedFields,
        correctionNote: correction.correctionNote,
      }));
    }
    return items.map((item) => byIndex.get(item.index) ?? item);
  }

  /**
   * V8-3 决策链（§四）：
   * (1) 保存不可变 Snapshot；(2) 标准化字段；(3) 解析 exact identity（provider-aware，多命中→冲突）；
   * (4) 加载已有 active 版本；(5) fingerprint v1 + 材料变化判定；(6) 决策分类；
   * (7) 按 decisionType 执行不可变版本决策并原子切换 activeVersionId。
   * 全程在 commit 的单一事务内执行，任一步抛错整批回滚。
   */
  private materializeItem(sessionId: string, item: RadarPreviewItem): CommitOutcomeItem {
    const now = this.deps.now();

    // (1) 不可变 Snapshot：无论后续是否建版本，只要 commit 合法即写入。
    const snapshot = this.buildSnapshot(sessionId, item, now);
    this.captures.insertSnapshot(snapshot);

    // (2) 确定性标准化。
    const norm = normalizeCandidateFields({
      recognizedFields: item.recognizedFields,
      rawDescription: item.visibleText,
    });

    // (3) exact identity（provider-aware；Tier2 多命中→identity_conflict）。
    const identity = resolveIdentity(
      { providerKey: item.providerKey, externalRecordId: item.externalRecordId, sourceUrl: item.sourceUrl },
      {
        findByProviderKey: (pk, ext) => this.sourceRecords.findByProviderKey(pk, ext),
        findAllByProviderAndUrl: (pk, url) => this.sourceRecords.findAllByProviderAndUrl(pk, url),
      },
    );

    // (4) 加载已有 active 版本（仅 exact_existing 且已挂主来源候选时）。
    const existingSourceRecord = identity.matched;
    const existingCandidate = existingSourceRecord === null
      ? null
      : this.candidates.findByPrimarySourceRecordId(existingSourceRecord.id);
    const previousVersion = existingCandidate !== null && existingCandidate.activeVersionId !== null
      ? this.candidates.getVersion(existingCandidate.activeVersionId)
      : null;

    // (5)+(6) fingerprint + 材料变化 → 决策分类。
    const decided = decideCommit({
      identity,
      previousNormalized: previousVersion?.normalized ?? null,
      nextNormalized: norm.normalized,
      ambiguousFields: norm.ambiguousFields,
      snapshotId: snapshot.id,
      // v0.9 Phase 2：Browser Capture 默认 FULL_EVIDENCE，保持原 v0.8 行为
      evidenceLevel: 'FULL_EVIDENCE',
    });
    const decisionType = decided.summary.decisionType;

    const outcome = (over: Partial<CommitOutcomeItem>): CommitOutcomeItem => ({
      index: item.index,
      candidateId: existingCandidate?.id ?? null,
      candidateVersionId: existingCandidate?.activeVersionId ?? null,
      sourceRecordId: existingSourceRecord?.id ?? null,
      snapshotId: snapshot.id,
      kind: legacyKind(decisionType),
      decisionType,
      analysisEligible: decided.summary.analysisEligible,
      decision: decided.summary,
      ...over,
    });

    // (7) identity_conflict：只留 Snapshot，不建候选/版本、不更新来源。
    if (decisionType === 'identity_conflict') {
      return outcome({ candidateId: null, candidateVersionId: null, sourceRecordId: null });
    }

    // 已有来源：刷新 last_seen；material_change 才更新 last_changed。
    if (existingSourceRecord !== null) {
      const changed = decisionType === 'material_change';
      this.sourceRecords.updateLatestSnapshot(
        existingSourceRecord.id, snapshot.id, now, changed ? now : existingSourceRecord.lastChangedAt, now,
      );
    }

    // 已有候选路径：no_change / snapshot_only / extraction_regression / ambiguous_change 不建版本；
    // material_change 建新不可变版本并原子切换 active。
    if (existingCandidate !== null && previousVersion !== null) {
      if (decisionType === 'material_change') {
        const version = this.insertNewVersion(existingCandidate, norm.normalized, decided.fingerprint, [snapshot.id], now, 'source_change');
        return outcome({ candidateVersionId: version.id });
      }
      // 其余判定：保留 active 版本不变。
      return outcome({ candidateVersionId: existingCandidate.activeVersionId });
    }

    // 新身份：建 SourceRecord（若无）+ Candidate + 首版 + primary SourceLink。
    const sourceRecord: RadarSourceRecord = existingSourceRecord ?? {
      id: this.deps.createId(),
      providerKey: item.providerKey,
      externalRecordId: item.externalRecordId,
      normalizedSourceUrl: identity.canonicalSourceUrl ?? item.normalizedSourceUrl,
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
    const version = this.insertNewVersion(candidate, norm.normalized, decided.fingerprint, [snapshot.id], now, 'captured');
    this.candidates.linkSource({
      candidateId: candidate.id,
      sourceRecordId: sourceRecord.id,
      firstLinkedAt: now,
      lastConfirmedAt: now,
      linkReason: 'primary',
    });

    return outcome({
      candidateId: candidate.id,
      candidateVersionId: version.id,
      sourceRecordId: sourceRecord.id,
    });
  }

  private buildSnapshot(sessionId: string, item: RadarPreviewItem, now: number): RadarCaptureSnapshot {
    return {
      id: this.deps.createId(),
      captureSessionId: sessionId,
      captureMethod: item.captureMethod,
      providerKey: item.providerKey,
      providerVersion: item.providerVersion,
      sourceDomain: item.sourceDomain,
      sourceUrl: item.sourceUrl,
      normalizedSourceUrl: item.normalizedSourceUrl,
      externalRecordId: item.externalRecordId,
      pageTitle: item.pageTitle,
      visibleText: item.visibleText,
      rawSnapshot: {
        captureMethod: item.captureMethod,
        visibleText: item.visibleText,
        // 完整 rich extraction 作为原始快照旁注，不进入结构化八字段。
        extractionMetadata: item.extractionMetadata ?? null,
      },
      rawContentHash: item.rawContentHash,
      capturedAt: item.capturedAt,
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
  ): RadarCandidateVersion {
    // Historical version reactivation：material change 提交前先查 (candidate_id, content_hash)。
    // 若历史已存在同 hash 版本（如 A→B→A 回退），复用并切回 active，绝不 INSERT 重复版本。
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
      // v0.9 Phase 1：Browser Capture 默认产生 FULL_EVIDENCE
      evidenceLevel: 'FULL_EVIDENCE',
      correctionNote: null,
      supersedesVersionId: candidate.activeVersionId,
      createdAt: now,
    };
    try {
      this.candidates.insertVersion(version);
    } catch (error) {
      // 并发兜底：仅当 UNIQUE(candidate_id, content_hash) 竞争时复用已存在版本；
      // 其它约束 / DB 错误继续向上抛出。
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

  private readItems(session: RadarCaptureSession): RadarPreviewItem[] {
    if (!Array.isArray(session.previewItems)) return [];
    return session.previewItems.map((raw) => RadarPreviewItemSchema.parse(raw));
  }

  private requireSession(id: string): RadarCaptureSession {
    const session = this.captures.getSession(id);
    if (session === null) throw radarSessionNotFound();
    return session;
  }

  private requireDraftableSession(id: string): RadarCaptureSession {
    const session = this.requireSession(id);
    this.assertDraftable(session);
    return session;
  }

  /** 会话必须处于 preview 且未过期才允许写操作；committed/cancelled 拒绝，过期则落 expired 并拒绝。 */
  private assertDraftable(session: RadarCaptureSession): void {
    if (session.status !== 'preview') throw radarSessionNotDraftable();
    if (session.expiresAt < this.deps.now()) {
      this.captures.updateSessionStatus(session.id, 'expired', null);
      throw radarSessionExpired();
    }
  }

  private transact<Result>(run: () => Result): Result {
    return this.db.transaction(run)();
  }
}

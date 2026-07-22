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
import {
  AddCaptureItemRequestSchema,
  CancelCaptureSessionRequestSchema,
  CommitCaptureSessionRequestSchema,
  CreateCaptureSessionRequestSchema,
  MAX_PREVIEW_ITEMS_PER_SESSION,
  RadarPreviewItemSchema,
  type AddCaptureItemRequest,
  type CommitCaptureSessionRequest,
  type RadarCaptureRecognizedFields,
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
  candidateId: string;
  candidateVersionId: string;
  sourceRecordId: string;
  snapshotId: string;
  kind: 'created' | 'unchanged' | 'new_version';
}

export interface CommitCaptureSessionResult {
  session: RadarCaptureSession;
  outcomes: CommitOutcomeItem[];
}

function buildNormalized(
  recognizedFields: RadarCaptureRecognizedFields | null,
  rawDescription: string,
): RadarCandidateNormalized {
  return {
    company: recognizedFields?.company ?? null,
    role: recognizedFields?.role ?? null,
    city: recognizedFields?.city ?? null,
    district: null,
    salaryMinK: recognizedFields?.salaryMinK ?? null,
    salaryMaxK: recognizedFields?.salaryMaxK ?? null,
    salaryPeriod: recognizedFields?.salaryPeriod ?? null,
    experienceRequirement: recognizedFields?.experienceRequirement ?? null,
    educationRequirement: recognizedFields?.educationRequirement ?? null,
    companySize: null,
    industry: null,
    jobNature: null,
    workMode: null,
    technicalStack: [],
    responsibilities: [],
    requirements: [],
    publishedAt: null,
    rawDescription,
  };
}

/**
 * V8-2 当前页采集桥：preview → correction → commit 的最小闭环。
 * 只负责 CaptureSnapshot / SourceRecord / Candidate / CandidateVersion 的落地，
 * 不实现 V8-3 的标准化、重复判定与相似度算法——重复判定仅按稳定来源 ID /
 * 规范化 URL / 内容 hash 做幂等，不做启发式相似度合并。
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

  private materializeItem(sessionId: string, item: RadarPreviewItem): CommitOutcomeItem {
    const now = this.deps.now();
    const snapshot: RadarCaptureSnapshot = {
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
        // §四：完整 rich extraction（district/详细地址/每字段 source/confidence/qualityIssues）
        // 作为原始快照旁注，不进入结构化八字段，也不写入 normalized city。
        extractionMetadata: item.extractionMetadata ?? null,
      },
      rawContentHash: item.rawContentHash,
      capturedAt: item.capturedAt,
      createdAt: now,
    };
    this.captures.insertSnapshot(snapshot);

    const existingSourceRecord = this.findExistingSourceRecord(item);
    const normalized = buildNormalized(item.recognizedFields, item.visibleText);
    const contentHash = sha256RequestHash(normalized);

    if (existingSourceRecord !== null) {
      this.sourceRecords.updateLatestSnapshot(
        existingSourceRecord.id,
        snapshot.id,
        now,
        existingSourceRecord.latestSnapshotId === snapshot.id ? null : now,
        now,
      );
      const existingCandidate = this.candidates.findByPrimarySourceRecordId(existingSourceRecord.id);
      if (existingCandidate !== null && existingCandidate.activeVersionId !== null) {
        const existingVersion = this.candidates.findVersionByContentHash(existingCandidate.id, contentHash);
        if (existingVersion !== null) {
          return {
            index: item.index,
            candidateId: existingCandidate.id,
            candidateVersionId: existingVersion.id,
            sourceRecordId: existingSourceRecord.id,
            snapshotId: snapshot.id,
            kind: 'unchanged',
          };
        }
        const version = this.insertNewVersion(existingCandidate, normalized, contentHash, [snapshot.id], now);
        return {
          index: item.index,
          candidateId: existingCandidate.id,
          candidateVersionId: version.id,
          sourceRecordId: existingSourceRecord.id,
          snapshotId: snapshot.id,
          kind: 'new_version',
        };
      }
    }

    const sourceRecord: RadarSourceRecord = existingSourceRecord ?? {
      id: this.deps.createId(),
      providerKey: item.providerKey,
      externalRecordId: item.externalRecordId,
      normalizedSourceUrl: item.normalizedSourceUrl,
      firstSeenAt: now,
      lastSeenAt: now,
      lastChangedAt: null,
      latestSnapshotId: snapshot.id,
      sourceStatus: 'active',
      createdAt: now,
      updatedAt: now,
    };
    if (existingSourceRecord === null) {
      this.sourceRecords.insert(sourceRecord);
    }

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
    const version = this.insertNewVersion(candidate, normalized, contentHash, [snapshot.id], now);
    this.candidates.linkSource({
      candidateId: candidate.id,
      sourceRecordId: sourceRecord.id,
      firstLinkedAt: now,
      lastConfirmedAt: now,
      linkReason: 'primary',
    });

    return {
      index: item.index,
      candidateId: candidate.id,
      candidateVersionId: version.id,
      sourceRecordId: sourceRecord.id,
      snapshotId: snapshot.id,
      kind: 'created',
    };
  }

  private insertNewVersion(
    candidate: RadarCandidate,
    normalized: RadarCandidateNormalized,
    contentHash: string,
    sourceSnapshotIds: string[],
    now: number,
  ): RadarCandidateVersion {
    const version: RadarCandidateVersion = {
      id: this.deps.createId(),
      candidateId: candidate.id,
      versionNo: this.candidates.nextVersionNo(candidate.id),
      normalized,
      qualityIssues: [],
      sourceSnapshotIds,
      contentHash,
      originType: candidate.activeVersionId === null ? 'captured' : 'source_change',
      correctionNote: null,
      supersedesVersionId: candidate.activeVersionId,
      createdAt: now,
    };
    this.candidates.insertVersion(version);
    this.candidates.setActiveVersionId(candidate.id, version.id, now);
    return version;
  }

  /** 幂等判定仅按稳定来源 ID 或规范化 URL 查找已有来源记录，不做内容相似度启发式（V8-3 范围外）。 */
  private findExistingSourceRecord(item: RadarPreviewItem): RadarSourceRecord | null {
    if (item.providerKey !== null && item.externalRecordId !== null) {
      const byProvider = this.sourceRecords.findByProviderKey(item.providerKey, item.externalRecordId);
      if (byProvider !== null) return byProvider;
    }
    if (item.normalizedSourceUrl !== null) {
      const byUrl = this.sourceRecords.findByNormalizedSourceUrl(item.normalizedSourceUrl);
      if (byUrl !== null) return byUrl;
    }
    return null;
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

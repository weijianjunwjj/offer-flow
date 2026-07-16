import { nanoid } from 'nanoid';
import {
  MarketPositionAcceptRequestSchema,
  MarketPositionActivateRequestSchema,
  MarketPositionDecisionRequestSchema,
  MarketPositionDraftSchema,
  MarketPositionManualProposalRequestSchema,
  MarketPositionViewSchema,
  type MarketPositionCommandType,
  type MarketPositionDraft,
  type MarketPositionProposal,
  type MarketPositionState,
  type MarketPositionView,
} from '../../src/domain/market-position';
import type { SqliteDatabase } from '../db';
import { canonicalJson, sha256RequestHash } from '../job-memory/requestHash';
import { CapabilityBaselineRepository } from '../capability-baseline/repository';
import { ProfileRepository } from '../repositories/profileRepository';
import { buildMarketPositionInputSnapshot } from './inputSnapshot';
import { MarketPositionError, invalidMarketPositionInput } from './errors';
import {
  MarketPositionRepository,
  MarketPositionStateVersionConflictError,
} from './repository';

export interface MarketPositionServiceDeps {
  now?: () => number;
  createId?: () => string;
}

function cloneDraft(draft: MarketPositionDraft): MarketPositionDraft {
  return structuredClone(draft);
}

function draftDiff(left: MarketPositionDraft, right: MarketPositionDraft): string[] {
  return Object.keys(left).filter((key) => (
    canonicalJson(left[key as keyof MarketPositionDraft])
      !== canonicalJson(right[key as keyof MarketPositionDraft])
  ));
}

/**
 * G4 市场位置画像服务。只支持手工提案/审核/激活工作流，不接入 AI 生成——
 * 若未来需要 AI 辅助，也只能用于润色文案，绝不能改动 EvidenceSufficiency/
 * DecisionGate/计数/id/blockedClaims；当前阶段未确认存在这样的安全能力，
 * 因此本服务暂不提供任何 AI 生成路径。
 */
export class MarketPositionService {
  private readonly repo: MarketPositionRepository;
  private readonly profiles: ProfileRepository;
  private readonly capabilityBaselines: CapabilityBaselineRepository;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly db: SqliteDatabase, deps: MarketPositionServiceDeps = {}) {
    this.repo = new MarketPositionRepository(db);
    this.profiles = new ProfileRepository(db);
    this.capabilityBaselines = new CapabilityBaselineRepository(db);
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? nanoid;
  }

  getView(): MarketPositionView {
    const state = this.repo.getState();
    return MarketPositionViewSchema.parse({
      state,
      activeVersion: state.activeVersionId === null
        ? null
        : state.versions.find(({ id }) => id === state.activeVersionId) ?? null,
      llmConfigured: false,
    });
  }

  createManualProposal(input: unknown): MarketPositionView {
    const parsed = MarketPositionManualProposalRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidMarketPositionInput(parsed.error);
    const requestHash = sha256RequestHash(parsed.data);
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    const current = this.requireState(parsed.data.expectedStateVersion);
    this.assertEffectiveChange(current, parsed.data.payload);
    const proposal = this.makeProposal(parsed.data.payload, 'manual', parsed.data.expectedStateVersion);
    return this.commit(parsed.data.expectedStateVersion, (state) => ({
      ...state,
      stateVersion: state.stateVersion + 1,
      proposals: [...state.proposals, proposal],
      commandReceipts: [...state.commandReceipts, this.receipt(
        parsed.data.idempotencyKey, 'manual_proposal', null, proposal.id, requestHash,
      )],
    }));
  }

  acceptProposal(id: string, input: unknown): MarketPositionView {
    const parsed = MarketPositionAcceptRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidMarketPositionInput(parsed.error);
    return this.decideProposal(id, parsed.data, 'accept_proposal', (state, proposal) => {
      const payload = parsed.data.modifiedPayload ?? proposal.payload;
      this.assertEffectiveChange(state, payload);
      const modified = parsed.data.modifiedPayload !== undefined
        && canonicalJson(parsed.data.modifiedPayload) !== canonicalJson(proposal.payload);
      const now = this.now();
      const versionId = this.createId();
      const previousActive = state.activeVersionId;
      const versionNumber = Math.max(0, ...state.versions.map(({ version }) => version)) + 1;
      const versions = state.versions.map((version) => (
        version.status === 'active' ? { ...version, status: 'archived' as const } : version
      ));
      versions.push({
        ...cloneDraft(payload),
        id: versionId,
        version: versionNumber,
        status: 'active',
        inputSnapshot: proposal.inputSnapshot,
        createdAt: now,
        activatedAt: now,
        supersedesVersionId: previousActive,
        proposalId: proposal.id,
      });
      return {
        ...state,
        activeVersionId: versionId,
        versions,
        proposals: state.proposals.map((candidate) => candidate.id === proposal.id ? {
          ...candidate,
          status: modified ? 'modified_and_accepted' : 'accepted',
          acceptedPayload: cloneDraft(payload),
          decisionDiff: modified ? draftDiff(candidate.payload, payload) : [],
          decidedAt: now,
          decisionNote: parsed.data.decisionNote ?? null,
        } : candidate),
      };
    });
  }

  rejectProposal(id: string, input: unknown): MarketPositionView {
    return this.simpleDecision(id, input, 'reject_proposal', 'rejected');
  }

  deferProposal(id: string, input: unknown): MarketPositionView {
    return this.simpleDecision(id, input, 'defer_proposal', 'deferred');
  }

  activateVersion(id: string, input: unknown): MarketPositionView {
    const parsed = MarketPositionActivateRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidMarketPositionInput(parsed.error);
    const requestHash = sha256RequestHash({ id, ...parsed.data });
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    return this.commit(parsed.data.expectedStateVersion, (state) => {
      const target = state.versions.find((version) => version.id === id);
      if (target === undefined) throw new MarketPositionError(404, 'ACTIVE_VERSION_NOT_FOUND', '市场位置画像版本不存在');
      if (state.activeVersionId === id) {
        throw new MarketPositionError(422, 'NO_EFFECTIVE_CHANGE', '该版本已经是当前正式市场位置画像');
      }
      const now = this.now();
      return {
        ...state,
        stateVersion: state.stateVersion + 1,
        activeVersionId: id,
        versions: state.versions.map((version) => ({
          ...version,
          status: version.id === id ? 'active' : 'archived',
          activatedAt: version.id === id ? now : version.activatedAt,
        })),
        commandReceipts: [...state.commandReceipts, this.receipt(
          parsed.data.idempotencyKey, 'activate_version', id, id, requestHash,
        )],
      };
    });
  }

  /**
   * 构建可供手工填写提案时参考的最新输入快照（不生成任何文案，只提供计数与来源 id）。
   */
  buildCurrentInputSnapshot(): ReturnType<typeof buildMarketPositionInputSnapshot> {
    const profile = this.profiles.get();
    const jobMatchState = profile?.jobMatchProfile;
    const jobMatchProfileVersionId = jobMatchState?.activeVersionId ?? null;
    const capabilityState = this.capabilityBaselines.getState();
    const capabilityBaselineVersionId = capabilityState.activeVersionId;
    const acceptedEvidenceIds = capabilityState.evidence
      .filter((item) => item.status === 'accepted' || item.status === 'modified_and_accepted')
      .map((item) => item.id);
    return buildMarketPositionInputSnapshot(this.db, {
      jobMatchProfileVersionId,
      capabilityBaselineVersionId,
      acceptedEvidenceIds,
    }, { now: this.now });
  }

  private simpleDecision(
    id: string,
    input: unknown,
    commandType: 'reject_proposal' | 'defer_proposal',
    status: 'rejected' | 'deferred',
  ): MarketPositionView {
    const parsed = MarketPositionDecisionRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidMarketPositionInput(parsed.error);
    return this.decideProposal(id, parsed.data, commandType, (state, proposal) => ({
      ...state,
      proposals: state.proposals.map((candidate) => candidate.id === proposal.id ? {
        ...candidate,
        status,
        decidedAt: this.now(),
        decisionNote: parsed.data.decisionNote ?? null,
      } : candidate),
    }));
  }

  private decideProposal(
    id: string,
    input: { idempotencyKey: string; expectedStateVersion: number },
    commandType: MarketPositionCommandType,
    decide: (state: MarketPositionState, proposal: MarketPositionProposal) => MarketPositionState,
  ): MarketPositionView {
    const requestHash = sha256RequestHash({ id, ...input });
    if (this.findReceipt(input.idempotencyKey, requestHash) !== null) return this.getView();
    return this.commit(input.expectedStateVersion, (state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new MarketPositionError(404, 'PROPOSAL_NOT_FOUND', '市场位置画像提案不存在');
      if (proposal.status !== 'proposed') {
        throw new MarketPositionError(409, 'PROPOSAL_ALREADY_DECIDED', '该市场位置画像提案已经处理');
      }
      const decided = decide(state, proposal);
      const resultId = decided.activeVersionId;
      return {
        ...decided,
        stateVersion: state.stateVersion + 1,
        commandReceipts: [...state.commandReceipts, this.receipt(
          input.idempotencyKey, commandType, id, resultId, requestHash,
        )],
      };
    });
  }

  private makeProposal(
    payload: MarketPositionDraft,
    generatedBy: 'ai' | 'manual',
    expectedStateVersion: number,
  ): MarketPositionProposal {
    const checked = MarketPositionDraftSchema.safeParse(payload);
    if (!checked.success) throw invalidMarketPositionInput(checked.error);
    const profile = this.profiles.get();
    const jobMatchState = profile?.jobMatchProfile;
    const capabilityState = this.capabilityBaselines.getState();
    const acceptedEvidenceIds = capabilityState.evidence
      .filter((item) => item.status === 'accepted' || item.status === 'modified_and_accepted')
      .map((item) => item.id);
    const snapshotResult = buildMarketPositionInputSnapshot(this.db, {
      jobMatchProfileVersionId: jobMatchState?.activeVersionId ?? null,
      capabilityBaselineVersionId: capabilityState.activeVersionId,
      acceptedEvidenceIds,
    }, { now: this.now });
    return {
      id: this.createId(),
      status: 'proposed',
      payload: cloneDraft(checked.data),
      acceptedPayload: null,
      decisionDiff: [],
      inputSnapshot: {
        jobMatchProfileVersionId: snapshotResult.jobMatchProfileVersionId,
        capabilityBaselineVersionId: snapshotResult.capabilityBaselineVersionId,
        acceptedEvidenceIds: snapshotResult.acceptedEvidenceIds,
        funnelCutoffAt: snapshotResult.funnelCutoffAt,
        funnelQueryFingerprint: snapshotResult.funnelQueryFingerprint,
        inputHash: snapshotResult.inputHash,
        capturedAt: snapshotResult.capturedAt,
      },
      generatedBy,
      modelInfo: null,
      createdAt: this.now(),
      decidedAt: null,
      decisionNote: null,
      expectedStateVersion,
    };
  }

  private receipt(
    idempotencyKey: string,
    commandType: MarketPositionCommandType,
    targetId: string | null,
    resultId: string | null,
    requestHash: string,
  ) {
    return { idempotencyKey, commandType, targetId, resultId, requestHash, createdAt: this.now() };
  }

  private findReceipt(idempotencyKey: string, requestHash: string) {
    const receipt = this.repo.getState().commandReceipts.find((item) => item.idempotencyKey === idempotencyKey);
    if (receipt !== undefined && receipt.requestHash !== requestHash) {
      throw new MarketPositionError(409, 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同请求');
    }
    return receipt ?? null;
  }

  private assertEffectiveChange(state: MarketPositionState, draft: MarketPositionDraft): void {
    if (state.activeVersionId === null) return;
    const active = state.versions.find(({ id }) => id === state.activeVersionId);
    if (active === undefined) throw new MarketPositionError(404, 'ACTIVE_VERSION_NOT_FOUND', '当前市场位置画像版本不存在');
    const {
      id: _id, version: _version, status: _status, inputSnapshot: _inputSnapshot,
      createdAt: _createdAt, activatedAt: _activatedAt,
      supersedesVersionId: _supersedesVersionId, proposalId: _proposalId,
      ...activeDraft
    } = active;
    if (canonicalJson(activeDraft) === canonicalJson(draft)) {
      throw new MarketPositionError(422, 'NO_EFFECTIVE_CHANGE', '提案与当前正式市场位置画像没有有效变化');
    }
  }

  private requireState(expected: number): MarketPositionState {
    const state = this.repo.getState();
    if (state.stateVersion !== expected) {
      throw new MarketPositionError(409, 'STATE_VERSION_CONFLICT', '市场位置画像状态已经变化，请重新加载', {
        currentVersion: state.stateVersion,
      });
    }
    return state;
  }

  private commit(
    expected: number,
    update: (state: MarketPositionState) => MarketPositionState,
  ): MarketPositionView {
    try {
      this.repo.updateState(expected, update);
      return this.getView();
    } catch (error) {
      if (error instanceof MarketPositionStateVersionConflictError) {
        throw new MarketPositionError(409, 'STATE_VERSION_CONFLICT', '市场位置画像状态已经变化，请重新加载', {
          currentVersion: error.currentVersion,
        });
      }
      throw error;
    }
  }
}

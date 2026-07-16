import { nanoid } from 'nanoid';
import {
  MarketPositionAcceptRequestSchema,
  MarketPositionActivateRequestSchema,
  MarketPositionDecisionRequestSchema,
  MarketPositionDraftSchema,
  MarketPositionGenerateProposalRequestSchema,
  MarketPositionManualProposalRequestSchema,
  MarketPositionViewSchema,
  type MarketPositionAiGenerationMetadata,
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
import {
  buildDeterministicMarketPositionDraft,
  buildMarketPositionAiFactsSnapshot,
  mergeAiNarrativeIntoDraft,
} from './aiMerge';
import {
  deepSeekMarketPositionProvider,
  MARKET_POSITION_PROMPT_VERSION,
  parseMarketPositionAiOutput,
  type MarketPositionAiProvider,
} from './aiProvider';
import { buildMarketPositionInputSnapshot, type MarketPositionInputSnapshotResult } from './inputSnapshot';
import { MarketPositionError, invalidMarketPositionInput } from './errors';
import {
  MarketPositionRepository,
  MarketPositionStateVersionConflictError,
} from './repository';

const DETERMINISTIC_RULE_VERSION = 'market-position-deterministic-v1';

export interface MarketPositionServiceDeps {
  now?: () => number;
  createId?: () => string;
  aiProvider?: MarketPositionAiProvider;
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
 * G4 市场位置画像服务。支持手工提案与 AI 生成提案两条路径，AI 路径由服务端先计算
 * 确定性草稿（EvidenceSufficiency/DecisionGate/计数/allowedClaims/blockedClaims），
 * 再调用 AI 只生成中文叙述文案并合并进确定性草稿——AI 输出中的确定性字段一律忽略，
 * 绝不信任前端传入的计数或结论，AI 也绝不能自动激活正式版本。
 */
export class MarketPositionService {
  private readonly repo: MarketPositionRepository;
  private readonly profiles: ProfileRepository;
  private readonly capabilityBaselines: CapabilityBaselineRepository;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly aiProvider: MarketPositionAiProvider;
  private readonly pendingGenerations = new Map<string, Promise<MarketPositionView>>();
  private readonly pendingInputHashes = new Map<string, string>();

  constructor(private readonly db: SqliteDatabase, deps: MarketPositionServiceDeps = {}) {
    this.repo = new MarketPositionRepository(db);
    this.profiles = new ProfileRepository(db);
    this.capabilityBaselines = new CapabilityBaselineRepository(db);
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? nanoid;
    this.aiProvider = deps.aiProvider ?? deepSeekMarketPositionProvider;
  }

  getView(reused = false): MarketPositionView {
    const state = this.repo.getState();
    return MarketPositionViewSchema.parse({
      state,
      activeVersion: state.activeVersionId === null
        ? null
        : state.versions.find(({ id }) => id === state.activeVersionId) ?? null,
      llmConfigured: this.aiProvider.isConfigured(),
      reused,
    });
  }

  /**
   * AI 生成市场位置提案：服务端重新读取 G1/G2/G3 正式数据并计算 inputHash，
   * 与前端 expectedInputHash 不一致时视为输入已过期；同一 inputHash 已存在
   * 未处理提案时直接返回既有提案，不重新调用模型，避免重复计费。
   */
  generateProposal(input: unknown, signal?: AbortSignal): Promise<MarketPositionView> {
    const parsed = MarketPositionGenerateProposalRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(invalidMarketPositionInput(parsed.error));
    const requestHash = sha256RequestHash(parsed.data);
    const existingReceipt = this.findReceipt(parsed.data.idempotencyKey, requestHash);
    if (existingReceipt !== null) return Promise.resolve(this.getView());
    const state = this.requireState(parsed.data.expectedStateVersion);
    if (!this.aiProvider.isConfigured()) {
      return Promise.reject(new MarketPositionError(
        503, 'MARKET_POSITION_AI_UNAVAILABLE', 'AI 服务尚未配置，可改用手工建立市场位置提案',
      ));
    }
    const snapshot = this.buildFreshSnapshot();
    if (
      parsed.data.expectedInputHash !== undefined
      && parsed.data.expectedInputHash !== null
      && parsed.data.expectedInputHash !== snapshot.inputHash
    ) {
      return Promise.reject(new MarketPositionError(
        409, 'MARKET_POSITION_INPUT_STALE', '正式输入数据已发生变化，请刷新后重新生成',
      ));
    }
    const existingOpenProposal = state.proposals.find((proposal) => (
      proposal.status === 'proposed'
      && proposal.generatedBy === 'ai'
      && proposal.inputSnapshot.inputHash === snapshot.inputHash
    ));
    if (existingOpenProposal !== undefined) {
      return Promise.resolve(this.getView(true));
    }
    const pendingInputKey = `${snapshot.inputHash}:${this.aiProvider.modelName()}`;
    const pendingIdempotency = this.pendingInputHashes.get(pendingInputKey);
    if (pendingIdempotency !== undefined && pendingIdempotency !== parsed.data.idempotencyKey) {
      return Promise.reject(new MarketPositionError(
        409, 'MARKET_POSITION_PROPOSAL_ALREADY_EXISTS', '相同输入正在生成 AI 提案，请稍候',
      ));
    }
    const sameRequest = this.pendingGenerations.get(parsed.data.idempotencyKey);
    if (sameRequest !== undefined) return sameRequest;

    const promise = this.finishAiGeneration(parsed.data, snapshot, signal)
      .finally(() => {
        this.pendingGenerations.delete(parsed.data.idempotencyKey);
        this.pendingInputHashes.delete(pendingInputKey);
      });
    this.pendingGenerations.set(parsed.data.idempotencyKey, promise);
    this.pendingInputHashes.set(pendingInputKey, parsed.data.idempotencyKey);
    return promise;
  }

  createManualProposal(input: unknown): MarketPositionView {
    const parsed = MarketPositionManualProposalRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidMarketPositionInput(parsed.error);
    const requestHash = sha256RequestHash(parsed.data);
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    const current = this.requireState(parsed.data.expectedStateVersion);
    this.assertEffectiveChange(current, parsed.data.payload);
    const proposal = this.makeProposal(parsed.data.payload, 'manual', null, parsed.data.expectedStateVersion);
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
    return this.buildFreshSnapshot();
  }

  /**
   * 服务端自行重新读取 G1/G2/G3 正式数据构建输入快照，绝不信任前端传入的计数或结论。
   */
  private buildFreshSnapshot(): MarketPositionInputSnapshotResult {
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

  private async finishAiGeneration(
    command: { idempotencyKey: string; expectedStateVersion: number },
    snapshot: MarketPositionInputSnapshotResult,
    signal?: AbortSignal,
  ): Promise<MarketPositionView> {
    const facts = buildMarketPositionAiFactsSnapshot(snapshot);
    const result = await this.aiProvider.generate(facts, signal);
    if (signal?.aborted) throw new DOMException('市场位置提案生成已取消', 'AbortError');

    const latestSnapshot = this.buildFreshSnapshot();
    if (latestSnapshot.inputHash !== snapshot.inputHash) {
      throw new MarketPositionError(409, 'MARKET_POSITION_INPUT_STALE', '生成期间正式输入数据已发生变化，请重新生成');
    }

    const parsedOutput = parseMarketPositionAiOutput(result.rawText, snapshot.acceptedEvidenceIds);
    if ('error' in parsedOutput) {
      throw new MarketPositionError(422, 'MARKET_POSITION_AI_OUTPUT_INVALID', 'AI 生成的市场位置文案未通过安全校验', {
        reason: parsedOutput.error,
      });
    }

    const deterministicDraft = buildDeterministicMarketPositionDraft(snapshot, {
      jobMatchProfileVersionId: snapshot.jobMatchProfileVersionId,
      capabilityBaselineVersionId: snapshot.capabilityBaselineVersionId,
      funnelCutoffAt: snapshot.funnelCutoffAt,
    }, snapshot.capturedAt);
    const mergedDraft = mergeAiNarrativeIntoDraft(deterministicDraft, parsedOutput.data);

    const aiGeneration: MarketPositionAiGenerationMetadata = {
      provider: 'deepseek',
      model: result.model,
      generatedAt: this.now(),
      inputHash: snapshot.inputHash,
      promptVersion: MARKET_POSITION_PROMPT_VERSION,
      deterministicRuleVersion: DETERMINISTIC_RULE_VERSION,
    };
    const proposal = this.makeProposal(mergedDraft, 'ai', aiGeneration, command.expectedStateVersion, snapshot);
    const requestHash = sha256RequestHash(command);
    return this.commit(command.expectedStateVersion, (state) => ({
      ...state,
      stateVersion: state.stateVersion + 1,
      proposals: [...state.proposals, proposal],
      commandReceipts: [...state.commandReceipts, this.receipt(
        command.idempotencyKey, 'generate_proposal', null, proposal.id, requestHash,
      )],
    }));
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
    aiGeneration: MarketPositionAiGenerationMetadata | null,
    expectedStateVersion: number,
    prebuiltSnapshot?: MarketPositionInputSnapshotResult,
  ): MarketPositionProposal {
    const checked = MarketPositionDraftSchema.safeParse(payload);
    if (!checked.success) throw invalidMarketPositionInput(checked.error);
    const snapshotResult = prebuiltSnapshot ?? this.buildFreshSnapshot();
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
      modelInfo: aiGeneration?.model ?? null,
      aiGeneration,
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

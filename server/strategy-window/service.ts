import { nanoid } from 'nanoid';
import {
  StrategyAcceptRequestSchema,
  StrategyActivateRequestSchema,
  StrategyDecisionRequestSchema,
  StrategyGenerateProposalRequestSchema,
  StrategyManualProposalRequestSchema,
  StrategyProposalDraftSchema,
  StrategyViewSchema,
  buildDeterministicStrategyDraft,
  computeStrategyWindow,
  validateStrategyDraft,
  type StrategyAiGenerationMetadata,
  type StrategyCommandType,
  type StrategyProposal,
  type StrategyProposalDraft,
  type StrategyState,
  type StrategyValidationError,
  type StrategyView,
  type StrategyWindow,
} from '../../src/domain/strategy-window';
import type { SqliteDatabase } from '../db';
import { canonicalJson, sha256RequestHash } from '../job-memory/requestHash';
import {
  buildStrategyAiFactsSnapshot,
  mergeAiNarrativeIntoStrategyDraft,
} from './aiMerge';
import {
  deepSeekStrategyProvider,
  parseStrategyAiOutput,
  STRATEGY_PROMPT_VERSION,
  type StrategyAiProvider,
} from './aiProvider';
import { buildStrategyInputSnapshot, type StrategyInputSnapshotResult } from './inputSnapshot';
import { StrategyError, invalidStrategyInput } from './errors';
import { StrategyRepository, StrategyStateVersionConflictError } from './repository';

const DETERMINISTIC_RULE_VERSION = 'strategy-window-deterministic-v1';

export interface StrategyServiceDeps {
  now?: () => number;
  createId?: () => string;
  aiProvider?: StrategyAiProvider;
}

function cloneDraft(draft: StrategyProposalDraft): StrategyProposalDraft {
  return structuredClone(draft);
}

function draftDiff(left: StrategyProposalDraft, right: StrategyProposalDraft): string[] {
  return Object.keys(left).filter((key) => (
    canonicalJson(left[key as keyof StrategyProposalDraft])
      !== canonicalJson(right[key as keyof StrategyProposalDraft])
  ));
}

function validationToError(errors: StrategyValidationError[]): StrategyError {
  const first = errors[0];
  const message = errors.map((error) => error.message).join('；');
  if (first?.code === 'allocation_invalid') {
    return new StrategyError(422, 'STRATEGY_ALLOCATION_INVALID', message);
  }
  if (first?.code === 'evidence_reference_invalid') {
    return new StrategyError(422, 'STRATEGY_EVIDENCE_REFERENCE_INVALID', message);
  }
  return new StrategyError(422, 'STRATEGY_ACTION_BLOCKED', message);
}

/**
 * G5 求职策略窗口与提案服务。窗口与门禁完全确定性：先由冻结的 G1–G4 输入快照计算
 * StrategyWindow 与允许/禁止的动作，再（AI 路径）调用模型只生成中文叙述并合并进确定性草稿，
 * 服务端对合并后的草稿重新执行门禁校验。AI 绝不能修改窗口类型、门禁、分配或证据引用，
 * 也绝不能自动激活正式版本或自动执行任何行动。
 */
export class StrategyService {
  private readonly repo: StrategyRepository;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly aiProvider: StrategyAiProvider;
  private readonly pendingGenerations = new Map<string, Promise<StrategyView>>();
  private readonly pendingInputHashes = new Map<string, string>();

  constructor(private readonly db: SqliteDatabase, deps: StrategyServiceDeps = {}) {
    this.repo = new StrategyRepository(db);
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? nanoid;
    this.aiProvider = deps.aiProvider ?? deepSeekStrategyProvider;
  }

  getView(reused = false): StrategyView {
    const state = this.repo.getState();
    const snapshot = this.buildFreshSnapshot();
    const currentWindow = snapshot === null ? null : this.computeWindow(snapshot);
    const currentInputHash = snapshot?.inputHash ?? null;
    const now = this.now();
    const decorated: StrategyState = {
      ...state,
      proposals: state.proposals.map((proposal) => ({
        ...proposal,
        stale: proposal.status === 'proposed' && (
          currentInputHash === null
          || proposal.inputSnapshot.inputHash !== currentInputHash
          || now > proposal.window.expiresAt
        ),
      })),
    };
    return StrategyViewSchema.parse({
      state: decorated,
      activeVersion: state.activeVersionId === null
        ? null
        : state.versions.find(({ id }) => id === state.activeVersionId) ?? null,
      currentWindow,
      inputReady: snapshot !== null,
      llmConfigured: this.aiProvider.isConfigured(),
      reused,
    }) as StrategyView;
  }

  buildCurrentInputSnapshot(): StrategyInputSnapshotResult | null {
    return this.buildFreshSnapshot();
  }

  generateProposal(input: unknown, signal?: AbortSignal): Promise<StrategyView> {
    const parsed = StrategyGenerateProposalRequestSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(invalidStrategyInput(parsed.error));
    const requestHash = sha256RequestHash(parsed.data);
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) {
      return Promise.resolve(this.getView());
    }
    const state = this.requireState(parsed.data.expectedStateVersion);
    const snapshot = this.buildFreshSnapshot();
    if (snapshot === null) {
      return Promise.reject(new StrategyError(
        409, 'STRATEGY_INPUT_NOT_READY',
        '尚无已验收的 G4 市场位置正式版本，无法生成求职策略窗口，请先在 G4 建立并激活正式版本',
      ));
    }
    if (!this.aiProvider.isConfigured()) {
      return Promise.reject(new StrategyError(
        503, 'STRATEGY_AI_UNAVAILABLE', 'AI 服务尚未配置，可改用手工建立求职策略提案',
      ));
    }
    if (
      parsed.data.expectedInputHash !== undefined
      && parsed.data.expectedInputHash !== null
      && parsed.data.expectedInputHash !== snapshot.inputHash
    ) {
      return Promise.reject(new StrategyError(
        409, 'STRATEGY_INPUT_STALE', '正式输入数据已发生变化，请刷新后重新生成',
      ));
    }
    const existingOpen = state.proposals.find((proposal) => (
      proposal.status === 'proposed'
      && proposal.generatedBy === 'ai'
      && proposal.inputSnapshot.inputHash === snapshot.inputHash
    ));
    if (existingOpen !== undefined) return Promise.resolve(this.getView(true));

    const pendingInputKey = `${snapshot.inputHash}:${this.aiProvider.modelName()}`;
    const pendingIdempotency = this.pendingInputHashes.get(pendingInputKey);
    if (pendingIdempotency !== undefined && pendingIdempotency !== parsed.data.idempotencyKey) {
      return Promise.reject(new StrategyError(
        409, 'STRATEGY_PROPOSAL_ALREADY_EXISTS', '相同输入正在生成 AI 策略提案，请稍候',
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

  createManualProposal(input: unknown): StrategyView {
    const parsed = StrategyManualProposalRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidStrategyInput(parsed.error);
    const requestHash = sha256RequestHash(parsed.data);
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    const current = this.requireState(parsed.data.expectedStateVersion);
    const snapshot = this.requireSnapshot();
    const window = this.computeWindow(snapshot);
    this.assertDraftPassesGates(parsed.data.payload, window, snapshot.acceptedEvidenceIds);
    this.assertEffectiveChange(current, parsed.data.payload);
    const proposal = this.makeProposal(
      window, parsed.data.payload, 'manual', null, parsed.data.expectedStateVersion, snapshot,
    );
    return this.commit(parsed.data.expectedStateVersion, (state) => ({
      ...state,
      stateVersion: state.stateVersion + 1,
      proposals: [...state.proposals, proposal],
      commandReceipts: [...state.commandReceipts, this.receipt(
        parsed.data.idempotencyKey, 'manual_proposal', null, proposal.id, requestHash,
      )],
    }));
  }

  acceptProposal(id: string, input: unknown): StrategyView {
    const parsed = StrategyAcceptRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidStrategyInput(parsed.error);
    return this.decideProposal(id, parsed.data, 'accept_proposal', (state, proposal) => {
      const payload = parsed.data.modifiedPayload ?? proposal.payload;
      this.assertProposalFresh(proposal);
      this.assertDraftPassesGates(payload, proposal.window, proposal.inputSnapshot.acceptedEvidenceIds);
      this.assertEffectiveChange(state, payload);
      const modified = parsed.data.modifiedPayload !== undefined
        && canonicalJson(parsed.data.modifiedPayload) !== canonicalJson(proposal.payload);
      const now = this.now();
      const versionId = this.createId();
      const previousActive = state.activeVersionId;
      const versionNumber = Math.max(0, ...state.versions.map(({ version }) => version)) + 1;
      const diff = modified ? draftDiff(proposal.payload, payload) : [];
      const versions = state.versions.map((version) => (
        version.status === 'active' ? { ...version, status: 'archived' as const } : version
      ));
      versions.push({
        id: versionId,
        version: versionNumber,
        status: 'active',
        window: proposal.window,
        payload: cloneDraft(payload),
        inputSnapshot: proposal.inputSnapshot,
        generationMode: proposal.generatedBy,
        decisionDiff: diff,
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
          decisionDiff: diff,
          decidedAt: now,
          decisionNote: parsed.data.decisionNote ?? null,
        } : candidate),
      };
    });
  }

  rejectProposal(id: string, input: unknown): StrategyView {
    return this.simpleDecision(id, input, 'reject_proposal', 'rejected');
  }

  deferProposal(id: string, input: unknown): StrategyView {
    return this.simpleDecision(id, input, 'defer_proposal', 'deferred');
  }

  activateVersion(id: string, input: unknown): StrategyView {
    const parsed = StrategyActivateRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidStrategyInput(parsed.error);
    const requestHash = sha256RequestHash({ id, ...parsed.data });
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    return this.commit(parsed.data.expectedStateVersion, (state) => {
      const target = state.versions.find((version) => version.id === id);
      if (target === undefined) throw new StrategyError(404, 'STRATEGY_ACTIVE_VERSION_NOT_FOUND', '求职策略版本不存在');
      if (state.activeVersionId === id) {
        throw new StrategyError(422, 'STRATEGY_NO_EFFECTIVE_CHANGE', '该版本已经是当前正式求职策略');
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

  private buildFreshSnapshot(): StrategyInputSnapshotResult | null {
    return buildStrategyInputSnapshot(this.db, { now: this.now });
  }

  private requireSnapshot(): StrategyInputSnapshotResult {
    const snapshot = this.buildFreshSnapshot();
    if (snapshot === null) {
      throw new StrategyError(
        409, 'STRATEGY_INPUT_NOT_READY',
        '尚无已验收的 G4 市场位置正式版本，无法生成求职策略窗口，请先在 G4 建立并激活正式版本',
      );
    }
    return snapshot;
  }

  private computeWindow(snapshot: StrategyInputSnapshotResult): StrategyWindow {
    return computeStrategyWindow({
      sourceVersionIds: {
        jobMatchProfileVersionId: snapshot.jobMatchProfileVersionId,
        capabilityBaselineVersionId: snapshot.capabilityBaselineVersionId,
        marketPositionVersionId: snapshot.marketPositionVersionId,
      },
      inputHash: snapshot.inputHash,
      dataCutoffAt: snapshot.funnelCutoffAt,
      evidenceLevel: snapshot.evidenceLevel,
      decisionGateStatuses: snapshot.decisionGateStatuses,
      allowedClaims: snapshot.allowedClaims,
      blockedClaims: snapshot.blockedClaims,
    }, { now: this.now, createId: () => `sw-${snapshot.inputHash.slice(0, 16)}` });
  }

  private async finishAiGeneration(
    command: { idempotencyKey: string; expectedStateVersion: number },
    snapshot: StrategyInputSnapshotResult,
    signal?: AbortSignal,
  ): Promise<StrategyView> {
    const window = this.computeWindow(snapshot);
    const deterministicDraft = buildDeterministicStrategyDraft(window, { createId: this.createId });
    const facts = buildStrategyAiFactsSnapshot(window, deterministicDraft, snapshot.acceptedEvidenceIds);
    const result = await this.aiProvider.generate(facts, signal);
    if (signal?.aborted) throw new DOMException('求职策略提案生成已取消', 'AbortError');

    const latestSnapshot = this.buildFreshSnapshot();
    if (latestSnapshot === null || latestSnapshot.inputHash !== snapshot.inputHash) {
      throw new StrategyError(409, 'STRATEGY_INPUT_STALE', '生成期间正式输入数据已发生变化，请重新生成');
    }

    const parsedOutput = parseStrategyAiOutput(result.rawText, snapshot.acceptedEvidenceIds);
    if ('error' in parsedOutput) {
      throw new StrategyError(422, 'STRATEGY_AI_OUTPUT_INVALID', 'AI 生成的求职策略文案未通过安全校验', {
        reason: parsedOutput.error,
      });
    }

    const mergedDraft = mergeAiNarrativeIntoStrategyDraft(deterministicDraft, parsedOutput.data);
    const gateErrors = validateStrategyDraft(mergedDraft, { window, acceptedEvidenceIds: snapshot.acceptedEvidenceIds });
    if (gateErrors.length > 0) {
      throw new StrategyError(422, 'STRATEGY_AI_OUTPUT_INVALID', 'AI 生成的求职策略未通过门禁校验', {
        reason: gateErrors.map((error) => error.message).join('；'),
      });
    }

    const aiGeneration: StrategyAiGenerationMetadata = {
      provider: 'deepseek',
      model: result.model,
      generatedAt: this.now(),
      inputHash: snapshot.inputHash,
      promptVersion: STRATEGY_PROMPT_VERSION,
      deterministicRuleVersion: DETERMINISTIC_RULE_VERSION,
    };
    const proposal = this.makeProposal(
      window, mergedDraft, 'ai', aiGeneration, command.expectedStateVersion, snapshot,
    );
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
  ): StrategyView {
    const parsed = StrategyDecisionRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidStrategyInput(parsed.error);
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
    commandType: StrategyCommandType,
    decide: (state: StrategyState, proposal: StrategyProposal) => StrategyState,
  ): StrategyView {
    const requestHash = sha256RequestHash({ id, ...input });
    if (this.findReceipt(input.idempotencyKey, requestHash) !== null) return this.getView();
    return this.commit(input.expectedStateVersion, (state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new StrategyError(404, 'STRATEGY_PROPOSAL_NOT_FOUND', '求职策略提案不存在');
      if (proposal.status !== 'proposed') {
        throw new StrategyError(409, 'STRATEGY_PROPOSAL_ALREADY_DECIDED', '该求职策略提案已经处理');
      }
      const decided = decide(state, proposal);
      return {
        ...decided,
        stateVersion: state.stateVersion + 1,
        commandReceipts: [...state.commandReceipts, this.receipt(
          input.idempotencyKey, commandType, id, decided.activeVersionId, requestHash,
        )],
      };
    });
  }

  private makeProposal(
    window: StrategyWindow,
    payload: StrategyProposalDraft,
    generatedBy: 'ai' | 'manual',
    aiGeneration: StrategyAiGenerationMetadata | null,
    expectedStateVersion: number,
    snapshot: StrategyInputSnapshotResult,
  ): StrategyProposal {
    const checked = StrategyProposalDraftSchema.safeParse(payload);
    if (!checked.success) throw invalidStrategyInput(checked.error);
    return {
      id: this.createId(),
      status: 'proposed',
      window,
      payload: cloneDraft(checked.data as StrategyProposalDraft),
      acceptedPayload: null,
      decisionDiff: [],
      inputSnapshot: {
        jobMatchProfileVersionId: snapshot.jobMatchProfileVersionId,
        capabilityBaselineVersionId: snapshot.capabilityBaselineVersionId,
        marketPositionVersionId: snapshot.marketPositionVersionId,
        acceptedEvidenceIds: snapshot.acceptedEvidenceIds,
        funnelCutoffAt: snapshot.funnelCutoffAt,
        funnelQueryFingerprint: snapshot.funnelQueryFingerprint,
        evidenceLevel: snapshot.evidenceLevel,
        decisionGateStatuses: snapshot.decisionGateStatuses,
        allowedClaims: snapshot.allowedClaims,
        blockedClaims: snapshot.blockedClaims,
        inputHash: snapshot.inputHash,
        capturedAt: snapshot.capturedAt,
      },
      generatedBy,
      modelInfo: aiGeneration?.model ?? null,
      aiGeneration,
      createdAt: this.now(),
      decidedAt: null,
      decisionNote: null,
      expectedStateVersion,
      stale: false,
    };
  }

  private assertDraftPassesGates(
    draft: StrategyProposalDraft,
    window: StrategyWindow,
    acceptedEvidenceIds: readonly string[],
  ): void {
    const parsed = StrategyProposalDraftSchema.safeParse(draft);
    if (!parsed.success) throw invalidStrategyInput(parsed.error);
    const errors = validateStrategyDraft(parsed.data as StrategyProposalDraft, { window, acceptedEvidenceIds });
    if (errors.length > 0) throw validationToError(errors);
  }

  private assertProposalFresh(proposal: StrategyProposal): void {
    const now = this.now();
    if (now > proposal.window.expiresAt) {
      throw new StrategyError(409, 'STRATEGY_WINDOW_EXPIRED', '该策略窗口已到期，请基于最新输入重新生成提案');
    }
    const snapshot = this.buildFreshSnapshot();
    if (snapshot === null || snapshot.inputHash !== proposal.inputSnapshot.inputHash) {
      throw new StrategyError(409, 'STRATEGY_INPUT_STALE', '正式输入数据已发生变化，该提案已失效，请重新生成');
    }
  }

  private receipt(
    idempotencyKey: string,
    commandType: StrategyCommandType,
    targetId: string | null,
    resultId: string | null,
    requestHash: string,
  ) {
    return { idempotencyKey, commandType, targetId, resultId, requestHash, createdAt: this.now() };
  }

  private findReceipt(idempotencyKey: string, requestHash: string) {
    const receipt = this.repo.getState().commandReceipts.find((item) => item.idempotencyKey === idempotencyKey);
    if (receipt !== undefined && receipt.requestHash !== requestHash) {
      throw new StrategyError(409, 'STRATEGY_IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同请求');
    }
    return receipt ?? null;
  }

  private assertEffectiveChange(state: StrategyState, draft: StrategyProposalDraft): void {
    if (state.activeVersionId === null) return;
    const active = state.versions.find(({ id }) => id === state.activeVersionId);
    if (active === undefined) throw new StrategyError(404, 'STRATEGY_ACTIVE_VERSION_NOT_FOUND', '当前求职策略版本不存在');
    if (canonicalJson(active.payload) === canonicalJson(draft)) {
      throw new StrategyError(422, 'STRATEGY_NO_EFFECTIVE_CHANGE', '提案与当前正式求职策略没有有效变化');
    }
  }

  private requireState(expected: number): StrategyState {
    const state = this.repo.getState();
    if (state.stateVersion !== expected) {
      throw new StrategyError(409, 'STRATEGY_STATE_VERSION_CONFLICT', '求职策略状态已经变化，请重新加载', {
        currentVersion: state.stateVersion,
      });
    }
    return state;
  }

  private commit(
    expected: number,
    update: (state: StrategyState) => StrategyState,
  ): StrategyView {
    try {
      this.repo.updateState(expected, update);
      return this.getView();
    } catch (error) {
      if (error instanceof StrategyStateVersionConflictError) {
        throw new StrategyError(409, 'STRATEGY_STATE_VERSION_CONFLICT', '求职策略状态已经变化，请重新加载', {
          currentVersion: error.currentVersion,
        });
      }
      throw error;
    }
  }
}

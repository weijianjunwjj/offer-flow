import { nanoid } from 'nanoid';
import {
  CandidateEvidenceContentSchema,
  CapabilityActivateRequestSchema,
  CapabilityBaselineAcceptRequestSchema,
  CapabilityBaselineDraftSchema,
  CapabilityBaselineViewSchema,
  CapabilityCommandBaseSchema,
  CapabilityEvidenceAcceptRequestSchema,
  CapabilityEvidenceDecisionRequestSchema,
  CapabilityManualBaselineProposalRequestSchema,
  CapabilityManualEvidenceRequestSchema,
  cloneCandidateEvidenceContent,
  cloneCapabilityBaselineDraft,
  evidenceGuardrailViolations,
  isDuplicateEvidence,
  type CandidateEvidence,
  type CandidateEvidenceContent,
  type CapabilityBaselineDraft,
  type CapabilityBaselineProposal,
  type CapabilityBaselineState,
  type CapabilityBaselineView,
  type CapabilityCommandType,
} from '../../src/domain/capability-baseline';
import type { SqliteDatabase } from '../db';
import { canonicalJson, sha256RequestHash } from '../job-memory/requestHash';
import { ProfileRepository } from '../repositories/profileRepository';
import {
  CapabilityBaselineRepository,
  CapabilityStateVersionConflictError,
} from './repository';
import {
  deepSeekCapabilityBaselineProvider,
  parseCapabilityEvidenceAiOutput,
  parseCapabilityBaselineAiOutput,
  type CapabilityBaselineAiProvider,
} from './aiProvider';
import { CapabilityBaselineError, invalidCapabilityInput } from './errors';
import { buildCapabilityBaselineInputSnapshot } from './inputSnapshot';

export interface CapabilityBaselineServiceDeps {
  now?: () => number;
  createId?: () => string;
  aiProvider?: CapabilityBaselineAiProvider;
}

function contentDiff(left: CandidateEvidenceContent, right: CandidateEvidenceContent): string[] {
  return Object.keys(left).filter((key) => (
    canonicalJson(left[key as keyof CandidateEvidenceContent])
      !== canonicalJson(right[key as keyof CandidateEvidenceContent])
  ));
}

function draftDiff(left: CapabilityBaselineDraft, right: CapabilityBaselineDraft): string[] {
  return Object.keys(left).filter((key) => (
    canonicalJson(left[key as keyof CapabilityBaselineDraft])
      !== canonicalJson(right[key as keyof CapabilityBaselineDraft])
  ));
}

export class CapabilityBaselineService {
  private readonly repo: CapabilityBaselineRepository;
  private readonly profiles: ProfileRepository;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly aiProvider: CapabilityBaselineAiProvider;
  private readonly pendingEvidence = new Map<string, Promise<CapabilityBaselineView>>();
  private readonly pendingBaseline = new Map<string, Promise<CapabilityBaselineView>>();

  constructor(private readonly db: SqliteDatabase, deps: CapabilityBaselineServiceDeps = {}) {
    this.repo = new CapabilityBaselineRepository(db);
    this.profiles = new ProfileRepository(db);
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? nanoid;
    this.aiProvider = deps.aiProvider ?? deepSeekCapabilityBaselineProvider;
  }

  getView(): CapabilityBaselineView {
    const state = this.repo.getState();
    return CapabilityBaselineViewSchema.parse({
      state,
      activeVersion: state.activeVersionId === null
        ? null
        : state.versions.find(({ id }) => id === state.activeVersionId) ?? null,
      llmConfigured: this.aiProvider.isConfigured(),
    });
  }

  // ---- Candidate evidence ----

  createManualEvidence(input: unknown): CapabilityBaselineView {
    const parsed = CapabilityManualEvidenceRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    const requestHash = sha256RequestHash(parsed.data);
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    const violations = evidenceGuardrailViolations(parsed.data.content);
    if (violations.length > 0) {
      throw new CapabilityBaselineError(422, 'GUARDRAIL_VIOLATION', violations[0]!, { violations });
    }
    const current = this.requireState(parsed.data.expectedStateVersion);
    const existingContents = current.evidence
      .filter((item) => item.status !== 'rejected')
      .map((item) => this.contentOf(item));
    if (isDuplicateEvidence(parsed.data.content, existingContents)) {
      throw new CapabilityBaselineError(409, 'DUPLICATE_EVIDENCE', '已存在同源候选证据，请勿重复录入');
    }
    const evidence = this.makeEvidence(parsed.data.content, 'manual', null, null, parsed.data.expectedStateVersion);
    return this.commit(parsed.data.expectedStateVersion, (state) => ({
      ...state,
      stateVersion: state.stateVersion + 1,
      evidence: [...state.evidence, evidence],
      commandReceipts: [...state.commandReceipts, this.receipt(
        parsed.data.idempotencyKey, 'manual_evidence', null, evidence.id, requestHash,
      )],
    }));
  }

  generateEvidence(input: unknown, signal?: AbortSignal): Promise<CapabilityBaselineView> {
    const parsed = CapabilityCommandBaseSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(invalidCapabilityInput(parsed.error));
    const existing = this.findReceipt(parsed.data.idempotencyKey, sha256RequestHash(parsed.data));
    if (existing !== null) return Promise.resolve(this.getView());
    if (!this.aiProvider.isConfigured()) {
      return Promise.reject(new CapabilityBaselineError(
        503, 'AI_PROVIDER_NOT_CONFIGURED', 'DeepSeek 尚未配置，可改用手工录入候选证据',
      ));
    }
    const inFlight = this.pendingEvidence.get(parsed.data.idempotencyKey);
    if (inFlight !== undefined) return inFlight;
    const promise = this.finishEvidenceGeneration(parsed.data, signal)
      .finally(() => this.pendingEvidence.delete(parsed.data.idempotencyKey));
    this.pendingEvidence.set(parsed.data.idempotencyKey, promise);
    return promise;
  }

  private async finishEvidenceGeneration(
    command: { idempotencyKey: string; expectedStateVersion: number },
    signal?: AbortSignal,
  ): Promise<CapabilityBaselineView> {
    const current = this.requireState(command.expectedStateVersion);
    const profile = this.requireProfile();
    const snapshot = buildCapabilityBaselineInputSnapshot(this.db, profile, current, { now: this.now });
    const result = await this.aiProvider.generateEvidence(snapshot.snapshot, signal);
    if (signal?.aborted) throw new DOMException('候选证据生成已取消', 'AbortError');
    const contents = parseCapabilityEvidenceAiOutput(result.rawText);
    const requestHash = sha256RequestHash(command);
    return this.commit(command.expectedStateVersion, (state) => {
      const existingContents = state.evidence
        .filter((item) => item.status !== 'rejected')
        .map((item) => this.contentOf(item));
      const added: CandidateEvidence[] = [];
      for (const content of contents) {
        if (evidenceGuardrailViolations(content).length > 0) continue;
        if (isDuplicateEvidence(content, [...existingContents, ...added.map((item) => this.contentOf(item))])) {
          continue;
        }
        added.push(this.makeEvidence(content, 'ai', result.model, snapshot.inputFingerprint, command.expectedStateVersion));
      }
      return {
        ...state,
        stateVersion: state.stateVersion + 1,
        evidence: [...state.evidence, ...added],
        commandReceipts: [...state.commandReceipts, this.receipt(
          command.idempotencyKey, 'generate_evidence', null,
          added.at(-1)?.id ?? null, requestHash,
        )],
      };
    });
  }

  acceptEvidence(id: string, input: unknown): CapabilityBaselineView {
    const parsed = CapabilityEvidenceAcceptRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    return this.decideEvidence(id, parsed.data, 'accept_evidence', (evidence) => {
      const original = this.contentOf(evidence);
      const finalContent = parsed.data.modifiedContent ?? original;
      const violations = evidenceGuardrailViolations(finalContent);
      if (violations.length > 0) {
        throw new CapabilityBaselineError(422, 'GUARDRAIL_VIOLATION', violations[0]!, { violations });
      }
      const modified = parsed.data.modifiedContent !== undefined
        && canonicalJson(parsed.data.modifiedContent) !== canonicalJson(original);
      return {
        ...evidence,
        status: modified ? 'modified_and_accepted' : 'accepted',
        acceptedContent: modified ? cloneCandidateEvidenceContent(finalContent) : null,
        decisionDiff: modified ? contentDiff(original, finalContent) : [],
        decidedAt: this.now(),
        decisionNote: parsed.data.decisionNote ?? null,
      };
    });
  }

  rejectEvidence(id: string, input: unknown): CapabilityBaselineView {
    const parsed = CapabilityEvidenceDecisionRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    return this.decideEvidence(id, parsed.data, 'reject_evidence', (evidence) => ({
      ...evidence,
      status: 'rejected',
      decidedAt: this.now(),
      decisionNote: parsed.data.decisionNote ?? null,
    }));
  }

  deferEvidence(id: string, input: unknown): CapabilityBaselineView {
    const parsed = CapabilityEvidenceDecisionRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    return this.decideEvidence(id, parsed.data, 'defer_evidence', (evidence) => ({
      ...evidence,
      status: 'deferred',
      decidedAt: this.now(),
      decisionNote: parsed.data.decisionNote ?? null,
    }));
  }

  private decideEvidence(
    id: string,
    input: { idempotencyKey: string; expectedStateVersion: number },
    commandType: CapabilityCommandType,
    decide: (evidence: CandidateEvidence) => CandidateEvidence,
  ): CapabilityBaselineView {
    const requestHash = sha256RequestHash({ id, ...input });
    if (this.findReceipt(input.idempotencyKey, requestHash) !== null) return this.getView();
    return this.commit(input.expectedStateVersion, (state) => {
      const evidence = state.evidence.find((item) => item.id === id);
      if (evidence === undefined) throw new CapabilityBaselineError(404, 'EVIDENCE_NOT_FOUND', '候选证据不存在');
      if (evidence.status !== 'proposed' && evidence.status !== 'deferred') {
        throw new CapabilityBaselineError(409, 'EVIDENCE_ALREADY_DECIDED', '该候选证据已处理');
      }
      const decided = decide(evidence);
      return {
        ...state,
        stateVersion: state.stateVersion + 1,
        evidence: state.evidence.map((item) => item.id === id ? decided : item),
        commandReceipts: [...state.commandReceipts, this.receipt(
          input.idempotencyKey, commandType, id, id, requestHash,
        )],
      };
    });
  }

  // ---- Baseline proposals & versions ----

  createManualBaselineProposal(input: unknown): CapabilityBaselineView {
    const parsed = CapabilityManualBaselineProposalRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    const requestHash = sha256RequestHash(parsed.data);
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    const current = this.requireState(parsed.data.expectedStateVersion);
    const profile = this.requireProfile();
    const snapshot = buildCapabilityBaselineInputSnapshot(this.db, profile, current, { now: this.now });
    this.assertBaselineReferencesExist(parsed.data.payload, current);
    const proposal = this.makeBaselineProposal(
      parsed.data.payload, 'manual', null, snapshot, this.acceptedEvidenceIds(current),
      parsed.data.expectedStateVersion,
    );
    return this.commit(parsed.data.expectedStateVersion, (state) => ({
      ...state,
      stateVersion: state.stateVersion + 1,
      proposals: [...state.proposals, proposal],
      commandReceipts: [...state.commandReceipts, this.receipt(
        parsed.data.idempotencyKey, 'manual_baseline_proposal', null, proposal.id, requestHash,
      )],
    }));
  }

  generateBaselineProposal(input: unknown, signal?: AbortSignal): Promise<CapabilityBaselineView> {
    const parsed = CapabilityCommandBaseSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(invalidCapabilityInput(parsed.error));
    const existing = this.findReceipt(parsed.data.idempotencyKey, sha256RequestHash(parsed.data));
    if (existing !== null) return Promise.resolve(this.getView());
    if (!this.aiProvider.isConfigured()) {
      return Promise.reject(new CapabilityBaselineError(
        503, 'AI_PROVIDER_NOT_CONFIGURED', 'DeepSeek 尚未配置，可改用手工建立能力基线提案',
      ));
    }
    const inFlight = this.pendingBaseline.get(parsed.data.idempotencyKey);
    if (inFlight !== undefined) return inFlight;
    const promise = this.finishBaselineGeneration(parsed.data, signal)
      .finally(() => this.pendingBaseline.delete(parsed.data.idempotencyKey));
    this.pendingBaseline.set(parsed.data.idempotencyKey, promise);
    return promise;
  }

  private async finishBaselineGeneration(
    command: { idempotencyKey: string; expectedStateVersion: number },
    signal?: AbortSignal,
  ): Promise<CapabilityBaselineView> {
    const current = this.requireState(command.expectedStateVersion);
    const profile = this.requireProfile();
    const snapshot = buildCapabilityBaselineInputSnapshot(this.db, profile, current, { now: this.now });
    const result = await this.aiProvider.generateBaseline(snapshot.snapshot, signal);
    if (signal?.aborted) throw new DOMException('能力基线提案生成已取消', 'AbortError');
    const payload = parseCapabilityBaselineAiOutput(result.rawText);
    const latestProfile = this.requireProfile();
    const latestSnapshot = buildCapabilityBaselineInputSnapshot(this.db, latestProfile, this.repo.getState(), { now: this.now });
    if (latestSnapshot.inputFingerprint !== snapshot.inputFingerprint) {
      throw new CapabilityBaselineError(409, 'STATE_VERSION_CONFLICT', '生成期间输入资料已变化，请重新生成');
    }
    const proposal = this.makeBaselineProposal(
      payload, 'ai', result.model, snapshot, this.acceptedEvidenceIds(current),
      command.expectedStateVersion,
    );
    const requestHash = sha256RequestHash(command);
    return this.commit(command.expectedStateVersion, (state) => ({
      ...state,
      stateVersion: state.stateVersion + 1,
      proposals: [...state.proposals, proposal],
      commandReceipts: [...state.commandReceipts, this.receipt(
        command.idempotencyKey, 'generate_baseline_proposal', null, proposal.id, requestHash,
      )],
    }));
  }

  acceptBaselineProposal(id: string, input: unknown): CapabilityBaselineView {
    const parsed = CapabilityBaselineAcceptRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    return this.decideBaselineProposal(id, parsed.data, 'accept_baseline_proposal', (state, proposal) => {
      const payload = parsed.data.modifiedPayload ?? proposal.payload;
      this.assertBaselineReferencesExist(payload, state);
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
        ...cloneCapabilityBaselineDraft(payload),
        id: versionId,
        version: versionNumber,
        status: 'active',
        sourceSnapshot: proposal.sourceSnapshot,
        evidenceRefs: [...proposal.evidenceRefs],
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
          acceptedPayload: cloneCapabilityBaselineDraft(payload),
          decisionDiff: modified ? draftDiff(candidate.payload, payload) : [],
          decidedAt: now,
          decisionNote: parsed.data.decisionNote ?? null,
        } : candidate),
      };
    });
  }

  rejectBaselineProposal(id: string, input: unknown): CapabilityBaselineView {
    return this.simpleBaselineDecision(id, input, 'reject_baseline_proposal', 'rejected');
  }

  deferBaselineProposal(id: string, input: unknown): CapabilityBaselineView {
    return this.simpleBaselineDecision(id, input, 'defer_baseline_proposal', 'deferred');
  }

  activateVersion(id: string, input: unknown): CapabilityBaselineView {
    const parsed = CapabilityActivateRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    const requestHash = sha256RequestHash({ id, ...parsed.data });
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getView();
    return this.commit(parsed.data.expectedStateVersion, (state) => {
      const target = state.versions.find((version) => version.id === id);
      if (target === undefined) throw new CapabilityBaselineError(404, 'ACTIVE_VERSION_NOT_FOUND', '能力基线版本不存在');
      if (state.activeVersionId === id) {
        throw new CapabilityBaselineError(422, 'NO_EFFECTIVE_CHANGE', '该版本已经是当前正式能力基线');
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
          parsed.data.idempotencyKey, 'activate_baseline_version', id, id, requestHash,
        )],
      };
    });
  }

  private simpleBaselineDecision(
    id: string,
    input: unknown,
    commandType: 'reject_baseline_proposal' | 'defer_baseline_proposal',
    status: 'rejected' | 'deferred',
  ): CapabilityBaselineView {
    const parsed = CapabilityEvidenceDecisionRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidCapabilityInput(parsed.error);
    return this.decideBaselineProposal(id, parsed.data, commandType, (state, proposal) => ({
      ...state,
      proposals: state.proposals.map((candidate) => candidate.id === proposal.id ? {
        ...candidate,
        status,
        decidedAt: this.now(),
        decisionNote: parsed.data.decisionNote ?? null,
      } : candidate),
    }));
  }

  private decideBaselineProposal(
    id: string,
    input: { idempotencyKey: string; expectedStateVersion: number },
    commandType: CapabilityCommandType,
    decide: (state: CapabilityBaselineState, proposal: CapabilityBaselineProposal) => CapabilityBaselineState,
  ): CapabilityBaselineView {
    const requestHash = sha256RequestHash({ id, ...input });
    if (this.findReceipt(input.idempotencyKey, requestHash) !== null) return this.getView();
    return this.commit(input.expectedStateVersion, (state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new CapabilityBaselineError(404, 'PROPOSAL_NOT_FOUND', '能力基线提案不存在');
      if (proposal.status !== 'proposed') {
        throw new CapabilityBaselineError(409, 'PROPOSAL_ALREADY_DECIDED', '该能力基线提案已处理');
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

  // ---- Helpers ----

  private contentOf(evidence: CandidateEvidence): CandidateEvidenceContent {
    if (evidence.acceptedContent !== null) return evidence.acceptedContent;
    return {
      capabilityKey: evidence.capabilityKey,
      capabilityLabel: evidence.capabilityLabel,
      polarity: evidence.polarity,
      strength: evidence.strength,
      sourceType: evidence.sourceType,
      sourceId: evidence.sourceId,
      sourceLabel: evidence.sourceLabel,
      city: evidence.city,
      summary: evidence.summary,
      observedAt: evidence.observedAt,
      timePrecision: evidence.timePrecision,
      sourceConfidence: evidence.sourceConfidence,
    };
  }

  private makeEvidence(
    content: CandidateEvidenceContent,
    generatedBy: 'ai' | 'manual' | 'system',
    modelInfo: string | null,
    inputFingerprint: string | null,
    expectedStateVersion: number,
  ): CandidateEvidence {
    const checked = CandidateEvidenceContentSchema.safeParse(content);
    if (!checked.success) throw invalidCapabilityInput(checked.error);
    return {
      ...cloneCandidateEvidenceContent(checked.data),
      id: this.createId(),
      generatedBy,
      status: 'proposed',
      acceptedContent: null,
      decisionDiff: [],
      modelInfo,
      inputFingerprint,
      createdAt: this.now(),
      decidedAt: null,
      decisionNote: null,
      expectedStateVersion,
    };
  }

  private makeBaselineProposal(
    payload: CapabilityBaselineDraft,
    generatedBy: 'ai' | 'manual',
    modelInfo: string | null,
    snapshot: ReturnType<typeof buildCapabilityBaselineInputSnapshot>,
    evidenceRefs: string[],
    expectedStateVersion: number,
  ): CapabilityBaselineProposal {
    const checked = CapabilityBaselineDraftSchema.safeParse(payload);
    if (!checked.success) throw invalidCapabilityInput(checked.error);
    return {
      id: this.createId(),
      status: 'proposed',
      payload: cloneCapabilityBaselineDraft(checked.data),
      acceptedPayload: null,
      decisionDiff: [],
      inputFingerprint: snapshot.inputFingerprint,
      generatedBy,
      modelInfo,
      sourceSnapshot: snapshot.sourceSnapshot,
      evidenceRefs: [...evidenceRefs],
      createdAt: this.now(),
      decidedAt: null,
      decisionNote: null,
      expectedStateVersion,
    };
  }

  private acceptedEvidenceIds(state: CapabilityBaselineState): string[] {
    return state.evidence
      .filter((item) => item.status === 'accepted' || item.status === 'modified_and_accepted')
      .map((item) => item.id);
  }

  /** 正式版本引用的证据必须存在且已接受。 */
  private assertBaselineReferencesExist(
    payload: CapabilityBaselineDraft,
    state: CapabilityBaselineState,
  ): void {
    const accepted = new Set(this.acceptedEvidenceIds(state));
    const refs = new Set<string>();
    for (const dimension of payload.capabilities) {
      for (const ref of [...dimension.supportingEvidenceRefs, ...dimension.counterEvidenceRefs]) refs.add(ref);
    }
    for (const constraint of payload.externalConstraints) {
      for (const ref of constraint.evidenceRefs) refs.add(ref);
    }
    const missing = [...refs].filter((ref) => !accepted.has(ref));
    if (missing.length > 0) {
      throw new CapabilityBaselineError(
        422, 'EVIDENCE_REFERENCE_MISSING', '能力基线引用的证据不存在或尚未接受', { missing },
      );
    }
  }

  private receipt(
    idempotencyKey: string,
    commandType: CapabilityCommandType,
    targetId: string | null,
    resultId: string | null,
    requestHash: string,
  ) {
    return { idempotencyKey, commandType, targetId, resultId, requestHash, createdAt: this.now() };
  }

  private findReceipt(idempotencyKey: string, requestHash: string) {
    const receipt = this.repo.getState().commandReceipts.find((item) => item.idempotencyKey === idempotencyKey);
    if (receipt !== undefined && receipt.requestHash !== requestHash) {
      throw new CapabilityBaselineError(409, 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同请求');
    }
    return receipt ?? null;
  }

  private requireProfile() {
    const profile = this.profiles.get();
    if (profile === null) throw new CapabilityBaselineError(404, 'PROFILE_NOT_FOUND', '请先建立简历与求职偏好配置');
    return profile;
  }

  private requireState(expected: number): CapabilityBaselineState {
    const state = this.repo.getState();
    if (state.stateVersion !== expected) {
      throw new CapabilityBaselineError(409, 'STATE_VERSION_CONFLICT', '能力基线状态已经变化，请重新加载', {
        currentVersion: state.stateVersion,
      });
    }
    return state;
  }

  private commit(
    expected: number,
    update: (state: CapabilityBaselineState) => CapabilityBaselineState,
  ): CapabilityBaselineView {
    try {
      this.repo.updateState(expected, update);
      return this.getView();
    } catch (error) {
      if (error instanceof CapabilityStateVersionConflictError) {
        throw new CapabilityBaselineError(409, 'STATE_VERSION_CONFLICT', '能力基线状态已经变化，请重新加载', {
          currentVersion: error.currentVersion,
        });
      }
      throw error;
    }
  }
}

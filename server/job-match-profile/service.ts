import { nanoid } from 'nanoid';
import {
  JobMatchAcceptRequestSchema,
  JobMatchActivateRequestSchema,
  JobMatchCommandBaseSchema,
  JobMatchDecisionRequestSchema,
  JobMatchManualProposalRequestSchema,
  JobMatchProfileDraftSchema,
  JobMatchProfileStateSchema,
  JobMatchProfileViewSchema,
  createEmptyJobMatchProfileState,
  type JobMatchCommandType,
  type JobMatchProfileDraft,
  type JobMatchProfileProposal,
  type JobMatchProfileState,
  type JobMatchProfileView,
} from '../../src/domain/job-match-profile';
import type { SqliteDatabase } from '../db';
import { canonicalJson, sha256RequestHash } from '../job-memory/requestHash';
import {
  ProfileRepository,
  ProfileStateVersionConflictError,
} from '../repositories/profileRepository';
import {
  deepSeekJobMatchProfileProvider,
  parseJobMatchProfileAiOutput,
  type JobMatchProfileAiProvider,
} from './aiProvider';
import { JobMatchProfileError, invalidProposal } from './errors';
import { buildJobMatchProfileInputSnapshot } from './inputSnapshot';

export interface JobMatchProfileServiceDeps {
  now?: () => number;
  createId?: () => string;
  aiProvider?: JobMatchProfileAiProvider;
}

function cloneDraft(draft: JobMatchProfileDraft): JobMatchProfileDraft {
  return structuredClone(draft);
}

function draftDiff(left: JobMatchProfileDraft, right: JobMatchProfileDraft): string[] {
  return Object.keys(left).filter((key) => (
    canonicalJson(left[key as keyof JobMatchProfileDraft])
      !== canonicalJson(right[key as keyof JobMatchProfileDraft])
  ));
}

export class JobMatchProfileService {
  private readonly profiles: ProfileRepository;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly aiProvider: JobMatchProfileAiProvider;
  private readonly pendingGenerations = new Map<string, Promise<JobMatchProfileView>>();
  private readonly pendingFingerprints = new Map<string, string>();

  constructor(private readonly db: SqliteDatabase, deps: JobMatchProfileServiceDeps = {}) {
    this.profiles = new ProfileRepository(db);
    this.now = deps.now ?? Date.now;
    this.createId = deps.createId ?? nanoid;
    this.aiProvider = deps.aiProvider ?? deepSeekJobMatchProfileProvider;
  }

  getProfile(): JobMatchProfileView {
    const profile = this.profiles.get();
    if (profile === null) throw new JobMatchProfileError(404, 'PROFILE_NOT_FOUND', '请先建立简历与求职偏好配置');
    const state = profile.jobMatchProfile === undefined
      ? createEmptyJobMatchProfileState()
      : JobMatchProfileStateSchema.parse(profile.jobMatchProfile);
    return JobMatchProfileViewSchema.parse({
      state,
      activeVersion: state.activeVersionId === null
        ? null
        : state.versions.find(({ id }) => id === state.activeVersionId) ?? null,
      llmConfigured: this.aiProvider.isConfigured(),
    });
  }

  generateProposal(input: unknown, signal?: AbortSignal): Promise<JobMatchProfileView> {
    const parsed = JobMatchCommandBaseSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(invalidProposal(parsed.error));
    const existing = this.findReceipt(parsed.data.idempotencyKey, sha256RequestHash(parsed.data));
    if (existing !== null) return Promise.resolve(this.getProfile());
    const current = this.requireCurrentVersion(parsed.data.expectedProfileStateVersion);
    if (!this.aiProvider.isConfigured()) {
      return Promise.reject(new JobMatchProfileError(
        503, 'AI_PROVIDER_NOT_CONFIGURED', 'DeepSeek 尚未配置，可改用手工建立画像提案',
      ));
    }
    const snapshot = buildJobMatchProfileInputSnapshot(this.db, current.profile, { now: this.now });
    const pendingKey = `${snapshot.inputFingerprint}:${this.aiProvider.modelName()}`;
    const pendingIdempotency = this.pendingFingerprints.get(pendingKey);
    if (pendingIdempotency !== undefined && pendingIdempotency !== parsed.data.idempotencyKey) {
      return Promise.reject(new JobMatchProfileError(
        409, 'DUPLICATE_PENDING_PROPOSAL', '相同资料与模型的画像提案正在生成',
      ));
    }
    const sameRequest = this.pendingGenerations.get(parsed.data.idempotencyKey);
    if (sameRequest !== undefined) return sameRequest;
    if (current.state.proposals.some((proposal) => (
      proposal.status === 'proposed'
      && proposal.inputFingerprint === snapshot.inputFingerprint
      && proposal.modelInfo === this.aiProvider.modelName()
    ))) {
      return Promise.reject(new JobMatchProfileError(
        409, 'DUPLICATE_PENDING_PROPOSAL', '相同资料与模型已有待审核画像提案',
      ));
    }
    const promise = this.finishAiGeneration(parsed.data, snapshot, signal)
      .finally(() => {
        this.pendingGenerations.delete(parsed.data.idempotencyKey);
        this.pendingFingerprints.delete(pendingKey);
      });
    this.pendingGenerations.set(parsed.data.idempotencyKey, promise);
    this.pendingFingerprints.set(pendingKey, parsed.data.idempotencyKey);
    return promise;
  }

  createManualProposal(input: unknown): JobMatchProfileView {
    const parsed = JobMatchManualProposalRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidProposal(parsed.error);
    const requestHash = sha256RequestHash(parsed.data);
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getProfile();
    const current = this.requireCurrentVersion(parsed.data.expectedProfileStateVersion);
    this.assertEffectiveChange(current.state, parsed.data.payload);
    const snapshot = buildJobMatchProfileInputSnapshot(this.db, current.profile, { now: this.now });
    const proposal = this.makeProposal(
      parsed.data.payload, 'manual', null, snapshot.inputFingerprint,
      snapshot.sourceSnapshot, parsed.data.expectedProfileStateVersion,
    );
    return this.updateState(parsed.data.expectedProfileStateVersion, (state) => ({
      ...state,
      stateVersion: state.stateVersion + 1,
      proposals: [...state.proposals, proposal],
      commandReceipts: [...state.commandReceipts, this.receipt(
        parsed.data.idempotencyKey, 'manual_proposal', null, proposal.id, requestHash,
      )],
    }));
  }

  acceptProposal(id: string, input: unknown): JobMatchProfileView {
    const parsed = JobMatchAcceptRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidProposal(parsed.error);
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
        sourceSnapshot: proposal.sourceSnapshot,
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

  rejectProposal(id: string, input: unknown): JobMatchProfileView {
    return this.simpleDecision(id, input, 'reject_proposal', 'rejected');
  }

  deferProposal(id: string, input: unknown): JobMatchProfileView {
    return this.simpleDecision(id, input, 'defer_proposal', 'deferred');
  }

  activateVersion(id: string, input: unknown): JobMatchProfileView {
    const parsed = JobMatchActivateRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidProposal(parsed.error);
    const requestHash = sha256RequestHash({ id, ...parsed.data });
    if (this.findReceipt(parsed.data.idempotencyKey, requestHash) !== null) return this.getProfile();
    return this.updateState(parsed.data.expectedProfileStateVersion, (state) => {
      const target = state.versions.find((version) => version.id === id);
      if (target === undefined) throw new JobMatchProfileError(404, 'ACTIVE_VERSION_NOT_FOUND', '画像版本不存在');
      if (state.activeVersionId === id) {
        throw new JobMatchProfileError(422, 'NO_EFFECTIVE_CHANGE', '该版本已经是当前正式画像');
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

  private async finishAiGeneration(
    command: { idempotencyKey: string; expectedProfileStateVersion: number },
    snapshot: ReturnType<typeof buildJobMatchProfileInputSnapshot>,
    signal?: AbortSignal,
  ): Promise<JobMatchProfileView> {
    const result = await this.aiProvider.generate(snapshot.snapshot, signal);
    if (signal?.aborted) throw new DOMException('画像提案生成已取消', 'AbortError');
    const payload = parseJobMatchProfileAiOutput(result.rawText);
    const latestProfile = this.profiles.get();
    if (latestProfile === null) throw new JobMatchProfileError(404, 'PROFILE_NOT_FOUND', '个人档案不存在');
    const latestSnapshot = buildJobMatchProfileInputSnapshot(this.db, latestProfile, { now: this.now });
    if (latestSnapshot.inputFingerprint !== snapshot.inputFingerprint) {
      throw new JobMatchProfileError(409, 'PROFILE_VERSION_CONFLICT', '生成期间画像输入资料已变化，请重新生成');
    }
    const proposal = this.makeProposal(
      payload, 'ai', result.model, snapshot.inputFingerprint,
      snapshot.sourceSnapshot, command.expectedProfileStateVersion,
    );
    const requestHash = sha256RequestHash(command);
    return this.updateState(command.expectedProfileStateVersion, (state) => ({
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
  ): JobMatchProfileView {
    const parsed = JobMatchDecisionRequestSchema.safeParse(input);
    if (!parsed.success) throw invalidProposal(parsed.error);
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
    input: { idempotencyKey: string; expectedProfileStateVersion: number },
    commandType: JobMatchCommandType,
    decide: (state: JobMatchProfileState, proposal: JobMatchProfileProposal) => JobMatchProfileState,
  ): JobMatchProfileView {
    const requestHash = sha256RequestHash({ id, ...input });
    if (this.findReceipt(input.idempotencyKey, requestHash) !== null) return this.getProfile();
    return this.updateState(input.expectedProfileStateVersion, (state) => {
      const proposal = state.proposals.find((candidate) => candidate.id === id);
      if (proposal === undefined) throw new JobMatchProfileError(404, 'PROPOSAL_NOT_FOUND', '画像提案不存在');
      if (proposal.status !== 'proposed') {
        throw new JobMatchProfileError(409, 'PROPOSAL_ALREADY_DECIDED', '该画像提案已经处理');
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
    payload: JobMatchProfileDraft,
    generatedBy: 'ai' | 'manual',
    modelInfo: string | null,
    inputFingerprint: string,
    sourceSnapshot: ReturnType<typeof buildJobMatchProfileInputSnapshot>['sourceSnapshot'],
    expectedProfileStateVersion: number,
  ): JobMatchProfileProposal {
    const checked = JobMatchProfileDraftSchema.safeParse(payload);
    if (!checked.success) throw invalidProposal(checked.error);
    return {
      id: this.createId(),
      status: 'proposed',
      payload: cloneDraft(checked.data),
      acceptedPayload: null,
      decisionDiff: [],
      inputFingerprint,
      generatedBy,
      modelInfo,
      sourceSnapshot,
      createdAt: this.now(),
      decidedAt: null,
      decisionNote: null,
      expectedProfileStateVersion,
    };
  }

  private receipt(
    idempotencyKey: string,
    commandType: JobMatchCommandType,
    targetId: string | null,
    resultId: string | null,
    requestHash: string,
  ) {
    return { idempotencyKey, commandType, targetId, resultId, requestHash, createdAt: this.now() };
  }

  private findReceipt(idempotencyKey: string, requestHash: string) {
    const receipt = this.getProfile().state.commandReceipts.find((item) => item.idempotencyKey === idempotencyKey);
    if (receipt !== undefined && receipt.requestHash !== requestHash) {
      throw new JobMatchProfileError(409, 'IDEMPOTENCY_KEY_REUSED', '幂等键已用于不同请求');
    }
    return receipt ?? null;
  }

  private assertEffectiveChange(state: JobMatchProfileState, draft: JobMatchProfileDraft): void {
    if (state.activeVersionId === null) return;
    const active = state.versions.find(({ id }) => id === state.activeVersionId);
    if (active === undefined) throw new JobMatchProfileError(404, 'ACTIVE_VERSION_NOT_FOUND', '当前画像版本不存在');
    const {
      id: _id, version: _version, status: _status, sourceSnapshot: _sourceSnapshot,
      createdAt: _createdAt, activatedAt: _activatedAt,
      supersedesVersionId: _supersedesVersionId, proposalId: _proposalId,
      ...activeDraft
    } = active;
    if (canonicalJson(activeDraft) === canonicalJson(draft)) {
      throw new JobMatchProfileError(422, 'NO_EFFECTIVE_CHANGE', '提案与当前正式画像没有有效变化');
    }
  }

  private requireCurrentVersion(expected: number) {
    const profile = this.profiles.get();
    if (profile === null) throw new JobMatchProfileError(404, 'PROFILE_NOT_FOUND', '请先建立简历与求职偏好配置');
    const state = profile.jobMatchProfile === undefined
      ? createEmptyJobMatchProfileState()
      : JobMatchProfileStateSchema.parse(profile.jobMatchProfile);
    if (state.stateVersion !== expected) {
      throw new JobMatchProfileError(409, 'PROFILE_VERSION_CONFLICT', '画像状态已经变化，请重新加载', {
        currentVersion: state.stateVersion,
      });
    }
    return { profile, state };
  }

  private updateState(
    expected: number,
    update: (state: JobMatchProfileState) => JobMatchProfileState,
  ): JobMatchProfileView {
    try {
      this.profiles.updateJobMatchProfile(expected, update);
      return this.getProfile();
    } catch (error) {
      if (error instanceof ProfileStateVersionConflictError) {
        throw new JobMatchProfileError(409, 'PROFILE_VERSION_CONFLICT', '画像状态已经变化，请重新加载', {
          currentVersion: error.currentVersion,
        });
      }
      if (error instanceof Error && error.message === 'PROFILE_NOT_FOUND') {
        throw new JobMatchProfileError(404, 'PROFILE_NOT_FOUND', '个人档案不存在');
      }
      throw error;
    }
  }
}

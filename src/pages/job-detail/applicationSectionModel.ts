import type {
  ApplicationChannel,
  ApplicationMemory,
  ApplicationOrigin,
  ApplicationRecord,
  CityContext,
  ContactSnapshot,
  RecruitingEntitySnapshot,
  ResumeVersionRecord,
} from '../../domain/job-memory';
import { selectDefaultApplication } from '../../domain/job-memory';
import type { UpdateApplicationMetadataRequest } from '../../../server/job-memory/dtoSchemas';

export type InitialApplicationEventType = 'none' | 'applied' | 'hr_contacted';

export interface ApplicationCreateDraft {
  idempotencyKey: string;
  resumeVersionId: string | null;
  origin: ApplicationOrigin;
  channel: ApplicationChannel;
  channelOtherLabel: string;
  recruitingEntity: RecruitingEntitySnapshot;
  primaryContact: ContactSnapshot | null;
  cityContext: CityContext;
  draftMessageText: string;
  initialEventType: InitialApplicationEventType;
  initialEventAtInput: string;
  initialEventTimePrecision: 'exact' | 'date' | 'approximate' | 'unknown';
  initialEventNote: string;
}

export interface ApplicationEditDraft {
  applicationId: string;
  resumeVersionId: string | null;
  channel: ApplicationChannel;
  channelOtherLabel: string;
  recruitingEntity: RecruitingEntitySnapshot;
  primaryContact: ContactSnapshot | null;
  cityContext: CityContext;
  draftMessageText: string;
  reason: string;
}

export interface ApplicationVoidDraft {
  applicationId: string;
  reason: string;
  supersededByApplicationId: string | null;
}

export interface ApplicationDraftState {
  create: ApplicationCreateDraft | null;
  edit: ApplicationEditDraft | null;
  void: ApplicationVoidDraft | null;
  baselineFingerprint: string;
}

export function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `application-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createEmptyApplicationDraft(
  resumeVersions: readonly ResumeVersionRecord[],
  activeResumeVersionId: string | null,
  jobCity: string,
): ApplicationCreateDraft {
  const selectableActive = resumeVersions.find((resumeVersion) => (
    resumeVersion.id === activeResumeVersionId && resumeVersion.archivedAt === null
  ));
  return {
    idempotencyKey: newIdempotencyKey(),
    resumeVersionId: selectableActive?.id ?? null,
    origin: 'outbound',
    channel: 'unknown',
    channelOtherLabel: '',
    recruitingEntity: {
      kind: 'unknown',
      name: null,
      employerGroupKey: null,
      endClientName: null,
    },
    primaryContact: null,
    cityContext: {
      jobCity: jobCity.trim() === '' ? null : jobCity.trim(),
      marketCity: null,
      workMode: 'unknown',
    },
    draftMessageText: '',
    initialEventType: 'applied',
    initialEventAtInput: '',
    initialEventTimePrecision: 'unknown',
    initialEventNote: '',
  };
}

export function createApplicationEditDraft(record: ApplicationRecord): ApplicationEditDraft {
  return {
    applicationId: record.id,
    resumeVersionId: record.resumeVersionId,
    channel: record.channel,
    channelOtherLabel: record.channelOtherLabel ?? '',
    recruitingEntity: { ...record.recruitingEntity },
    primaryContact: record.primaryContact === null ? null : { ...record.primaryContact },
    cityContext: { ...record.cityContext },
    draftMessageText: record.draftMessageText ?? '',
    reason: '',
  };
}

export function fingerprintApplicationDrafts(drafts: ApplicationDraftState): string {
  return JSON.stringify({ create: drafts.create, edit: drafts.edit, void: drafts.void });
}

function compareDescending(left: ApplicationMemory, right: ApplicationMemory): number {
  const leftMeaningful = left.projection.lastMeaningfulEventAt ?? Number.NEGATIVE_INFINITY;
  const rightMeaningful = right.projection.lastMeaningfulEventAt ?? Number.NEGATIVE_INFINITY;
  return rightMeaningful - leftMeaningful
    || right.record.createdAt - left.record.createdAt
    || right.record.id.localeCompare(left.record.id);
}

export function defaultApplicationId(applications: readonly ApplicationMemory[]): string | null {
  return selectDefaultApplication(applications.map(({ record, projection }) => ({
    application: record,
    projection,
  })))?.application.id ?? null;
}

export function reconcileSelectedApplicationId(
  applications: readonly ApplicationMemory[],
  selectedApplicationId: string | null,
): string | null {
  const selected = applications.find(({ record }) => record.id === selectedApplicationId);
  if (selected && selected.record.voidedAt === null && !selected.projection.isVoided) {
    return selected.record.id;
  }
  return defaultApplicationId(applications);
}

export function sortApplicationMemories(
  applications: readonly ApplicationMemory[],
  defaultId: string | null,
): ApplicationMemory[] {
  return [...applications].sort((left, right) => {
    const leftDefault = left.record.id === defaultId ? 1 : 0;
    const rightDefault = right.record.id === defaultId ? 1 : 0;
    if (leftDefault !== rightDefault) return rightDefault - leftDefault;
    const leftOpen = left.record.voidedAt === null && !left.projection.isClosed ? 1 : 0;
    const rightOpen = right.record.voidedAt === null && !right.projection.isClosed ? 1 : 0;
    return rightOpen - leftOpen || compareDescending(left, right);
  });
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function nullableText(value: string): string | null {
  const normalized = value.trim();
  return normalized === '' ? null : normalized;
}

export function buildApplicationUpdateRequest(
  current: ApplicationRecord,
  draft: ApplicationEditDraft,
): UpdateApplicationMetadataRequest | null {
  const candidate = {
    resumeVersionId: draft.resumeVersionId,
    channel: draft.channel,
    channelOtherLabel: draft.channel === 'other' ? nullableText(draft.channelOtherLabel) : null,
    recruitingEntity: {
      ...draft.recruitingEntity,
      name: nullableText(draft.recruitingEntity.name ?? ''),
      employerGroupKey: nullableText(draft.recruitingEntity.employerGroupKey ?? ''),
      endClientName: nullableText(draft.recruitingEntity.endClientName ?? ''),
    },
    primaryContact: draft.primaryContact === null ? null : {
      ...draft.primaryContact,
      displayName: nullableText(draft.primaryContact.displayName ?? ''),
      platformId: nullableText(draft.primaryContact.platformId ?? ''),
    },
    cityContext: {
      ...draft.cityContext,
      jobCity: nullableText(draft.cityContext.jobCity ?? ''),
      marketCity: nullableText(draft.cityContext.marketCity ?? ''),
    },
    draftMessageText: nullableText(draft.draftMessageText),
  };
  const patch: Record<string, unknown> = {
    expectedVersion: current.rowVersion,
    reason: draft.reason.trim(),
  };
  for (const key of Object.keys(candidate) as Array<keyof typeof candidate>) {
    if (!equal(current[key], candidate[key])) patch[key] = candidate[key];
  }
  return Object.keys(patch).length === 2 ? null : patch as UpdateApplicationMetadataRequest;
}

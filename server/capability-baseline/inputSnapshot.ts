import {
  classifyEventForCapability,
  type CandidateEvidenceContent,
  type CapabilityBaselineDraft,
  type CapabilityBaselineSnapshotResult,
  type CapabilityBaselineState,
  type CapabilityEvidencePolarity,
} from '../../src/domain/capability-baseline';
import { projectApplication } from '../../src/domain/job-memory';
import type { JobSeekerProfile } from '../../src/storage';
import type { SqliteDatabase } from '../db';
import { ApplicationRepository } from '../job-memory/applicationRepository';
import { FeedbackEventRepository } from '../job-memory/feedbackEventRepository';
import { sha256RequestHash } from '../job-memory/requestHash';
import { ResumeVersionRepository } from '../job-memory/resumeVersionRepository';
import { JobRepository } from '../repositories/jobRepository';
import { normalizeJobMatchCity } from '../job-match-profile/inputSnapshot';

export interface BuildCapabilityBaselineSnapshotOptions {
  now?: () => number;
}

function effectiveEvidenceContent(
  state: CapabilityBaselineState,
): CandidateEvidenceContent[] {
  return state.evidence
    .filter((item) => item.status === 'accepted' || item.status === 'modified_and_accepted')
    .map((item) => {
      const content = item.acceptedContent ?? {
        capabilityKey: item.capabilityKey,
        capabilityLabel: item.capabilityLabel,
        polarity: item.polarity,
        strength: item.strength,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        sourceLabel: item.sourceLabel,
        city: item.city,
        summary: item.summary,
        observedAt: item.observedAt,
        timePrecision: item.timePrecision,
        sourceConfidence: item.sourceConfidence,
      };
      return content;
    });
}

function activeCapabilityBaselineDraft(
  state: CapabilityBaselineState,
): CapabilityBaselineDraft | null {
  if (state.activeVersionId === null) return null;
  const version = state.versions.find(({ id }) => id === state.activeVersionId);
  if (version === undefined) return null;
  return {
    summary: version.summary,
    capabilities: version.capabilities,
    externalConstraints: version.externalConstraints,
    overallConfidence: version.overallConfidence,
    largestUncertainties: version.largestUncertainties,
  };
}

function activeJobMatchProfileSummary(profile: JobSeekerProfile): string | null {
  const state = profile.jobMatchProfile;
  if (state?.activeVersionId === null || state?.activeVersionId === undefined) return null;
  const version = state.versions.find(({ id }) => id === state.activeVersionId);
  return version?.northStarPositioning ?? null;
}

export function buildCapabilityBaselineInputSnapshot(
  db: SqliteDatabase,
  profile: JobSeekerProfile,
  state: CapabilityBaselineState,
  options: BuildCapabilityBaselineSnapshotOptions = {},
): CapabilityBaselineSnapshotResult {
  const jobRepo = new JobRepository(db);
  const applicationRepo = new ApplicationRepository(db);
  const eventRepo = new FeedbackEventRepository(db);
  const resumeRepo = new ResumeVersionRepository(db);

  const jobs = jobRepo.list();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const jobEntries = jobs
    .map((job) => ({
      id: job.id,
      company: job.company,
      role: job.role,
      city: normalizeJobMatchCity(job.city),
      salaryRange: job.salaryRange,
      matchScore: String(job.matchScore ?? ''),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const applicationEntries: CapabilityBaselineSnapshotResult['snapshot']['applications'] = [];
  const feedbackEntries: CapabilityBaselineSnapshotResult['snapshot']['feedbackEvents'] = [];

  for (const application of applicationRepo.listApplications()) {
    if (application.voidedAt !== null) continue;
    const job = jobsById.get(application.jobId);
    const city = normalizeJobMatchCity(
      application.cityContext.marketCity ?? application.cityContext.jobCity ?? job?.city ?? null,
    );
    const events = eventRepo.listEventsByApplication(application.id);
    const projection = projectApplication(application, events);
    if (projection.isVoided || projection.projectionStatus === 'invalid') continue;
    applicationEntries.push({
      id: application.id,
      jobId: application.jobId,
      city,
      stage: projection.stage,
      outcome: projection.outcome,
    });
    const voidedIds = new Set(events
      .filter((event) => event.eventType === 'event_voided')
      .map((event) => event.targetEventId));
    for (const event of events) {
      if (event.eventType === 'event_voided' || voidedIds.has(event.id)) continue;
      const classification = classifyEventForCapability(event.eventType, event.reasonCode);
      const polarity: CapabilityEvidencePolarity = classification.kind === 'capability_signal'
        ? classification.polarity
        : 'neutral';
      feedbackEntries.push({
        id: event.id,
        applicationId: application.id,
        eventType: event.eventType,
        reasonCode: event.reasonCode,
        evidenceLevel: event.evidenceLevel,
        capabilitySignal: polarity,
      });
    }
  }

  applicationEntries.sort((left, right) => left.id.localeCompare(right.id));
  feedbackEntries.sort((left, right) => left.id.localeCompare(right.id));

  const activeResumeVersionId = resumeRepo.getActiveResumeVersionId();
  const activeResume = activeResumeVersionId === null
    ? null
    : resumeRepo.getResumeVersion(activeResumeVersionId);
  const acceptedEvidence = effectiveEvidenceContent(state);

  const snapshot: CapabilityBaselineSnapshotResult['snapshot'] = {
    profile: {
      resumeText: profile.resumeText,
      projectExperience: profile.projectExperience,
      targetCity: profile.targetCity,
      targetRole: profile.targetRole,
      expectedSalary: profile.expectedSalary,
      acceptOutsourcing: profile.acceptOutsourcing,
      acceptOvertime: profile.acceptOvertime,
      jobSearchFocus: profile.jobSearchFocus,
      weaknessNote: profile.weaknessNote,
    },
    activeResumeVersion: activeResume === null ? null : {
      id: activeResume.id,
      name: activeResume.name,
      summary: activeResume.summary,
      resumeText: activeResume.contentSnapshot.resumeText,
      projectExperience: activeResume.contentSnapshot.projectExperience,
    },
    jobs: jobEntries,
    applications: applicationEntries,
    feedbackEvents: feedbackEntries,
    acceptedEvidence,
    activeJobMatchProfileSummary: activeJobMatchProfileSummary(profile),
    activeCapabilityBaseline: activeCapabilityBaselineDraft(state),
  };

  const inputFingerprint = sha256RequestHash(snapshot);
  return {
    snapshot,
    inputFingerprint,
    sourceSnapshot: {
      inputFingerprint,
      activeResumeVersionId,
      acceptedEvidenceCount: acceptedEvidence.length,
      jobCount: jobEntries.length,
      applicationCount: applicationEntries.length,
      feedbackEventCount: feedbackEntries.length,
      capturedAt: (options.now ?? Date.now)(),
    },
  };
}

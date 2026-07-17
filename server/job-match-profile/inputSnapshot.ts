import {
  JOB_MATCH_CITY_CODES,
  type JobMatchCityCode,
  type JobMatchProfileApplicationInput,
  type JobMatchProfileDraft,
  type JobMatchProfileEventInput,
  type JobMatchProfileOpportunityInput,
  type JobMatchProfileSnapshotResult,
} from '../../src/domain/job-match-profile';
import { projectApplication } from '../../src/domain/job-memory';
import type { JobSeekerProfile } from '../../src/storage';
import type { SqliteDatabase } from '../db';
import { ApplicationRepository } from '../job-memory/applicationRepository';
import { FeedbackEventRepository } from '../job-memory/feedbackEventRepository';
import { sha256RequestHash } from '../job-memory/requestHash';
import { ResumeVersionRepository } from '../job-memory/resumeVersionRepository';
import { JobRepository } from '../repositories/jobRepository';

export interface BuildJobMatchProfileInputSnapshotOptions {
  now?: () => number;
}

export function normalizeJobMatchCity(value: string | null | undefined): JobMatchCityCode | null {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized.includes('苏州') || normalized === 'suzhou') return 'suzhou';
  if (normalized.includes('无锡') || normalized === 'wuxi') return 'wuxi';
  if (normalized.includes('上海') || normalized === 'shanghai') return 'shanghai';
  if (normalized.includes('杭州') || normalized === 'hangzhou') return 'hangzhou';
  return null;
}

function activeDraft(profile: JobSeekerProfile): JobMatchProfileDraft | null {
  const state = profile.jobMatchProfile;
  if (state?.activeVersionId === null || state?.activeVersionId === undefined) return null;
  const version = state.versions.find(({ id }) => id === state.activeVersionId);
  if (version === undefined) return null;
  const {
    id: _id, version: _version, status: _status, sourceSnapshot: _sourceSnapshot,
    createdAt: _createdAt, activatedAt: _activatedAt,
    supersedesVersionId: _supersedesVersionId, proposalId: _proposalId,
    ...draft
  } = version;
  return draft;
}

function capabilitySignal(eventType: string, reasonCode: string | null): JobMatchProfileEventInput['capabilitySignal'] {
  if (['interview_advanced', 'offer_received', 'offer_accepted'].includes(eventType)) return 'support';
  if (eventType === 'rejected' && ['skills', 'experience'].includes(reasonCode ?? '')) return 'counter';
  return 'neutral';
}

function sourceKey(
  city: JobMatchCityCode,
  company: string,
  role: string,
  employerGroupKey: string | null,
): string {
  return [city, employerGroupKey?.trim().toLowerCase() || company.trim().toLowerCase(), role.trim().toLowerCase()]
    .join('|');
}

export function buildJobMatchProfileInputSnapshot(
  db: SqliteDatabase,
  profile: JobSeekerProfile,
  options: BuildJobMatchProfileInputSnapshotOptions = {},
): JobMatchProfileSnapshotResult {
  const jobs = new JobRepository(db).list();
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const applicationRepo = new ApplicationRepository(db);
  const eventRepo = new FeedbackEventRepository(db);
  const resumeRepo = new ResumeVersionRepository(db);
  const grouped = new Map<string, JobMatchProfileOpportunityInput>();

  for (const application of applicationRepo.listApplications()) {
    if (application.voidedAt !== null) continue;
    const job = jobsById.get(application.jobId);
    if (job === undefined) continue;
    const city = normalizeJobMatchCity(application.cityContext.marketCity ?? application.cityContext.jobCity ?? job.city);
    if (city === null) continue;
    const events = eventRepo.listEventsByApplication(application.id);
    const projection = projectApplication(application, events);
    if (projection.isVoided || projection.projectionStatus === 'invalid') continue;
    const voidedIds = new Set(events
      .filter((event) => event.eventType === 'event_voided')
      .map((event) => event.targetEventId));
    const activeEvents = events.filter((event) => (
      event.eventType !== 'event_voided' && !voidedIds.has(event.id)
    ));
    const key = sourceKey(city, job.company, job.role, application.recruitingEntity.employerGroupKey);
    const applicationInput: JobMatchProfileApplicationInput = {
      id: application.id,
      jobId: application.jobId,
      resumeVersionId: application.resumeVersionId,
      channel: application.channel,
      employerGroupKey: application.recruitingEntity.employerGroupKey,
      stage: projection.stage,
      outcome: projection.outcome,
      submissionState: projection.submissionState,
      createdAt: application.createdAt,
      events: activeEvents.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        eventAt: event.eventAt,
        actor: event.actor,
        sourceConfidence: event.sourceConfidence,
        evidenceLevel: event.evidenceLevel,
        note: event.note,
        reasonCode: event.reasonCode,
        capabilitySignal: capabilitySignal(event.eventType, event.reasonCode),
      })).sort((left, right) => (
        (left.eventAt ?? 0) - (right.eventAt ?? 0) || left.id.localeCompare(right.id)
      )),
    };
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        sourceKey: key,
        jobId: job.id,
        company: job.company,
        role: job.role,
        city,
        salaryRange: job.salaryRange,
        jdText: job.jdText,
        matchScore: job.matchScore,
        companyAssessment: job.companyAssessment,
        opportunityAnalysis: job.opportunityAnalysis,
        applications: [applicationInput],
      });
    } else {
      existing.applications.push(applicationInput);
    }
  }

  const opportunities = [...grouped.values()]
    .map((opportunity) => ({
      ...opportunity,
      applications: opportunity.applications.sort((left, right) => (
        left.createdAt - right.createdAt || left.id.localeCompare(right.id)
      )),
    }))
    .sort((left, right) => left.sourceKey.localeCompare(right.sourceKey));
  const activeResumeVersionId = resumeRepo.getActiveResumeVersionId();
  const activeResume = activeResumeVersionId === null
    ? null
    : resumeRepo.getResumeVersion(activeResumeVersionId);
  const cityGroups = Object.fromEntries(JOB_MATCH_CITY_CODES.map((city) => {
    const cityOpportunities = opportunities.filter((opportunity) => opportunity.city === city);
    const applicationCount = cityOpportunities.reduce((sum, item) => sum + item.applications.length, 0);
    const feedbackEventCount = cityOpportunities.reduce((sum, item) => (
      sum + item.applications.reduce((eventSum, application) => eventSum + application.events.length, 0)
    ), 0);
    const missingEvidence: string[] = [];
    if (applicationCount === 0) missingEvidence.push('缺少该城市真实求职流程');
    if (feedbackEventCount === 0) missingEvidence.push('缺少该城市招聘反馈');
    if (!cityOpportunities.some(({ salaryRange }) => salaryRange.trim() !== '')) {
      missingEvidence.push('缺少该城市可比较薪资信息');
    }
    return [city, {
      city,
      opportunitySourceKeys: cityOpportunities.map(({ sourceKey: value }) => value),
      applicationCount,
      feedbackEventCount,
      independentEmployerCount: new Set(cityOpportunities.map(({ sourceKey: value }) => value.split('|')[1])).size,
      missingEvidence,
    }];
  })) as JobMatchProfileSnapshotResult['snapshot']['cityGroups'];
  const snapshot: JobMatchProfileSnapshotResult['snapshot'] = {
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
    opportunities,
    cityGroups,
    activeProfileVersion: activeDraft(profile),
  };
  const inputFingerprint = sha256RequestHash(snapshot);
  return {
    snapshot,
    inputFingerprint,
    sourceSnapshot: {
      inputFingerprint,
      activeResumeVersionId,
      jobCount: opportunities.length,
      applicationCount: opportunities.reduce((sum, item) => sum + item.applications.length, 0),
      feedbackEventCount: opportunities.reduce((sum, item) => (
        sum + item.applications.reduce((eventSum, application) => eventSum + application.events.length, 0)
      ), 0),
      cityApplicationCounts: Object.fromEntries(JOB_MATCH_CITY_CODES.map((city) => [
        city, cityGroups[city].applicationCount,
      ])) as Record<JobMatchCityCode, number>,
      capturedAt: (options.now ?? Date.now)(),
    },
  };
}

import { ApplicationProjectionSchema } from '../domain/job-memory';
import type {
  ApplicationMemory,
  ApplicationProjection,
  ApplicationSummary,
} from '../domain/job-memory';
import type { CommunicationStatus, JobRecord } from '../storage';

export type DecisionFactsSource =
  | 'application_projection'
  | 'legacy_job_fallback'
  | 'opportunity_only';

export interface LegacyJobCommunicationFacts {
  communicationStatus: CommunicationStatus;
  followupCount: number;
  lastGreetedAt: number | null;
  lastFollowupAt: number | null;
  lastCommunicationNote: string | null;
}

export interface DecisionApplicationFacts {
  applicationId: string;
  projection: ApplicationProjection;
}

export type DecisionOpportunityFacts =
  | {
      source: 'application_projection';
      job: JobRecord;
      application: DecisionApplicationFacts;
      legacyCommunication: null;
    }
  | {
      source: 'legacy_job_fallback';
      job: JobRecord;
      application: null;
      legacyCommunication: LegacyJobCommunicationFacts;
    }
  | {
      source: 'opportunity_only';
      job: JobRecord;
      application: null;
      legacyCommunication: null;
    };

export type DecisionApplicationCandidate = Pick<ApplicationMemory, 'record' | 'projection'>
  | ApplicationSummary;

export interface ResolveDecisionOpportunityFactsInput {
  job: JobRecord;
  selectedApplication: DecisionApplicationCandidate | null;
  defaultApplication: DecisionApplicationCandidate | null;
  availableApplications?: readonly DecisionApplicationCandidate[];
  jobMemoryV2Enabled: boolean;
}

export function legacyCommunicationFacts(job: JobRecord): LegacyJobCommunicationFacts {
  return {
    communicationStatus: job.communicationStatus,
    followupCount: job.followupCount,
    lastGreetedAt: job.lastGreetedAt ?? null,
    lastFollowupAt: job.lastFollowupAt ?? null,
    lastCommunicationNote: job.lastCommunicationNote?.trim() || null,
  };
}

export function hasMeaningfulLegacyCommunication(
  facts: LegacyJobCommunicationFacts,
): boolean {
  return facts.communicationStatus !== 'not_contacted'
    || facts.followupCount > 0
    || facts.lastGreetedAt !== null
    || facts.lastFollowupAt !== null
    || facts.lastCommunicationNote !== null;
}

function usableCandidate(
  candidate: DecisionApplicationCandidate | null | undefined,
): candidate is DecisionApplicationCandidate {
  return candidate !== null
    && candidate !== undefined
    && candidate.record.voidedAt === null
    && !candidate.projection.isVoided;
}

function fallbackApplication(
  candidates: readonly DecisionApplicationCandidate[],
): DecisionApplicationCandidate | null {
  return [...candidates]
    .filter(usableCandidate)
    .sort((left, right) => {
      const leftValid = left.projection.projectionStatus === 'invalid' ? 0 : 1;
      const rightValid = right.projection.projectionStatus === 'invalid' ? 0 : 1;
      const leftTime = left.projection.lastMeaningfulEventAt ?? Number.NEGATIVE_INFINITY;
      const rightTime = right.projection.lastMeaningfulEventAt ?? Number.NEGATIVE_INFINITY;
      return rightValid - leftValid
        || rightTime - leftTime
        || right.record.createdAt - left.record.createdAt
        || right.record.id.localeCompare(left.record.id);
    })[0] ?? null;
}

export function resolveDecisionOpportunityFacts(
  input: ResolveDecisionOpportunityFactsInput,
): DecisionOpportunityFacts {
  const legacy = legacyCommunicationFacts(input.job);
  if (!input.jobMemoryV2Enabled) {
    return {
      source: 'legacy_job_fallback',
      job: input.job,
      application: null,
      legacyCommunication: legacy,
    };
  }

  const application = usableCandidate(input.selectedApplication)
    ? input.selectedApplication
    : usableCandidate(input.defaultApplication)
      ? input.defaultApplication
      : fallbackApplication(input.availableApplications ?? []);
  if (application !== null) {
    return {
      source: 'application_projection',
      job: input.job,
      application: {
        applicationId: application.record.id,
        projection: application.projection,
      },
      legacyCommunication: null,
    };
  }

  if (hasMeaningfulLegacyCommunication(legacy)) {
    return {
      source: 'legacy_job_fallback',
      job: input.job,
      application: null,
      legacyCommunication: legacy,
    };
  }
  return {
    source: 'opportunity_only',
    job: input.job,
    application: null,
    legacyCommunication: null,
  };
}

export function assertDecisionOpportunityFacts(
  facts: DecisionOpportunityFacts,
): asserts facts is DecisionOpportunityFacts {
  if (!facts.job || typeof facts.job.id !== 'string' || facts.job.id.trim() === '') {
    throw new TypeError('DecisionOpportunityFacts.job 必须是有效 JobRecord');
  }
  switch (facts.source) {
    case 'application_projection': {
      if (facts.legacyCommunication !== null || facts.application === null) {
        throw new TypeError('application_projection 只能携带 ApplicationProjection');
      }
      if (facts.application.applicationId.trim() === '') {
        throw new TypeError('application_projection 缺少 applicationId');
      }
      const parsed = ApplicationProjectionSchema.safeParse(facts.application.projection);
      if (!parsed.success) {
        throw new TypeError('application_projection 的 Projection 结构无效');
      }
      if (parsed.data.isVoided) {
        throw new TypeError('已作废 Application 不得作为决策输入');
      }
      return;
    }
    case 'legacy_job_fallback':
      if (facts.application !== null || facts.legacyCommunication === null) {
        throw new TypeError('legacy_job_fallback 只能携带 legacyCommunication');
      }
      return;
    case 'opportunity_only':
      if (facts.application !== null || facts.legacyCommunication !== null) {
        throw new TypeError('opportunity_only 不得携带流程事实');
      }
      return;
    default: {
      throw new TypeError('DecisionOpportunityFacts.source 无效');
    }
  }
}

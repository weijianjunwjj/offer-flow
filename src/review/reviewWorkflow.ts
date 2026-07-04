import type { CommunicationStatus, JobRecord, ReviewStatus } from '../storage';

export type ReviewAction = 'confirm' | 'defer' | 'reject';

const RESOLVED_REVIEW_STATUSES: ReadonlySet<ReviewStatus> = new Set([
  'confirmed',
  'deferred',
  'rejected',
]);

function isClosedCommunicationStatus(status: CommunicationStatus): boolean {
  return status === 'closed' || status === 'rejected';
}

function updatedAtFrom(job: JobRecord, now?: string): number {
  if (now === undefined) {
    return job.updatedAt;
  }
  const timestamp = Date.parse(now);
  return Number.isFinite(timestamp) ? timestamp : job.updatedAt;
}

export function isPendingReview(job: JobRecord): boolean {
  if (isClosedCommunicationStatus(job.communicationStatus)) {
    return false;
  }
  if (job.reviewStatus === 'pending_review') {
    return true;
  }
  if (job.reviewStatus !== undefined && RESOLVED_REVIEW_STATUSES.has(job.reviewStatus)) {
    return false;
  }
  return job.importedDraft !== undefined && job.importStatus === 'imported_draft';
}

export function getAvailableReviewActions(job: JobRecord): ReviewAction[] {
  return isPendingReview(job) ? ['confirm', 'defer', 'reject'] : [];
}

function communicationStatusAfterConfirm(job: JobRecord): CommunicationStatus {
  if (isClosedCommunicationStatus(job.communicationStatus)) {
    return job.communicationStatus;
  }
  if (job.communicationStatus === 'paused') {
    return 'not_contacted';
  }
  return job.communicationStatus;
}

export function applyReviewAction(
  job: JobRecord,
  action: ReviewAction,
  now?: string,
): JobRecord {
  const updatedAt = updatedAtFrom(job, now);

  switch (action) {
    case 'confirm':
      return {
        ...job,
        reviewStatus: 'confirmed',
        communicationStatus: communicationStatusAfterConfirm(job),
        updatedAt,
      };
    case 'defer':
      return {
        ...job,
        reviewStatus: 'deferred',
        communicationStatus: 'paused',
        updatedAt,
      };
    case 'reject':
      return {
        ...job,
        reviewStatus: 'rejected',
        communicationStatus: 'rejected',
        updatedAt,
      };
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

import {
  applyReviewAction,
  getAvailableReviewActions,
  isPendingReview,
} from '../src/review/reviewWorkflow';
import { emptyCompanyInput } from '../src/storage';
import type { ImportedJdDraft, JobRecord } from '../src/storage';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const importedDraft: ImportedJdDraft = {
  recommendedCategory: 'wait_review',
  reason: 'Imported JD requires human review before follow-up.',
  confidence: 0.72,
  riskFlags: ['salary unclear'],
  warnings: ['company size missing'],
  missingFields: ['companySize'],
  rawText: 'raw imported jd text',
  sourceCreatedAt: '2026-07-04T00:00:00.000Z',
};

function baseJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'review-job-1',
    createdAt: 1,
    updatedAt: 1,
    company: 'Review Test Co',
    role: 'Frontend Engineer',
    city: 'Suzhou',
    salaryRange: '20-30K',
    jdText: 'Vue TypeScript',
    promptText: '',
    aiRawResult: 'AI raw result must stay.',
    aiPastedAt: 1,
    parseStatus: 'unparsed',
    report: null,
    matchScore: '',
    companyInput: emptyCompanyInput(),
    companyAssessment: null,
    opportunityAnalysis: null,
    communicationStatus: 'paused',
    followupCount: 0,
    highValueSignal: false,
    importStatus: 'imported_draft',
    reviewStatus: 'pending_review',
    importedDraft,
    ...overrides,
  };
}

section('Pending review detection');

const pendingJob = baseJob();
check('pending_review job is pending review', isPendingReview(pendingJob));
check(
  'pending_review job exposes confirm/defer/reject actions',
  getAvailableReviewActions(pendingJob).join(',') === 'confirm,defer,reject',
);
check(
  'ordinary job is not pending review',
  !isPendingReview(
    baseJob({
      importStatus: undefined,
      reviewStatus: undefined,
      importedDraft: undefined,
      communicationStatus: 'not_contacted',
    }),
  ),
);
check(
  'imported draft without explicit reviewStatus is pending review',
  isPendingReview(baseJob({ reviewStatus: undefined })),
);

section('Review actions');

const confirmed = applyReviewAction(pendingJob, 'confirm', '2026-07-04T10:00:00.000Z');
check('confirm sets reviewStatus confirmed', confirmed.reviewStatus === 'confirmed');
check('confirm clears pending review', !isPendingReview(confirmed));
check('confirm moves imported paused draft back to not_contacted', confirmed.communicationStatus === 'not_contacted');
check('confirm does not mark greeting as sent', confirmed.communicationStatus !== 'greeted_unread');
check('confirm does not return confirm action again', !getAvailableReviewActions(confirmed).includes('confirm'));

const deferred = applyReviewAction(pendingJob, 'defer', '2026-07-04T10:00:00.000Z');
check('defer sets reviewStatus deferred', deferred.reviewStatus === 'deferred');
check('defer keeps opportunity paused', deferred.communicationStatus === 'paused');
check('defer preserves job identity', deferred.id === pendingJob.id);
check('defer clears pending review actions', getAvailableReviewActions(deferred).length === 0);

const rejected = applyReviewAction(pendingJob, 'reject', '2026-07-04T10:00:00.000Z');
check('reject sets reviewStatus rejected', rejected.reviewStatus === 'rejected');
check('reject enters terminal communication status', rejected.communicationStatus === 'rejected');
check('reject clears pending review', !isPendingReview(rejected));
check('reject does not delete aiRawResult', rejected.aiRawResult === pendingJob.aiRawResult);
check('reject does not delete importedDraft', rejected.importedDraft === pendingJob.importedDraft);
check('reject preserves parseStatus', rejected.parseStatus === pendingJob.parseStatus);

section('Terminal guards');

check(
  'confirmed job does not expose review actions',
  getAvailableReviewActions(baseJob({ reviewStatus: 'confirmed', communicationStatus: 'not_contacted' })).length === 0,
);
check(
  'closed opportunity does not expose review actions',
  getAvailableReviewActions(baseJob({ communicationStatus: 'closed' })).length === 0,
);
check(
  'rejected opportunity does not expose review actions',
  getAvailableReviewActions(baseJob({ communicationStatus: 'rejected' })).length === 0,
);

section('Summary');
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

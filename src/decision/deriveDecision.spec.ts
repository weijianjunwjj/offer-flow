import { describe, expect, it } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { makeApplication, makeEvent } from '../domain/job-memory/testFixtures';
import { projectApplication, type ApplicationMemory, type FeedbackEventType } from '../domain/job-memory';
import {
  deriveCompanyWarning,
  deriveDecision,
  deriveLegacyDecision,
  FOLLOWUP_COOLDOWN_DAYS,
} from './deriveDecision';
import { resolveDecisionOpportunityFacts, type DecisionOpportunityFacts } from './decisionOpportunityFacts';

const DAY = 24 * 60 * 60 * 1000;

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1', createdAt: 1, updatedAt: 1, company: '同公司', role: '前端', city: '苏州',
    salaryRange: '', jdText: '', promptText: '', aiRawResult: '', aiPastedAt: null,
    parseStatus: 'none', report: {
      jobType: '', keywords: '', techStackMatch: '', projectMatch: '', strengths: '', risks: '',
      resumeAdvice: '', interviewChecklist: '', applyAdvice: 'ok', greetingMessage: '',
    },
    matchScore: '', companyInput: emptyCompanyInput(), companyAssessment: null,
    opportunityAnalysis: null, communicationStatus: 'not_contacted', followupCount: 0,
    highValueSignal: false, ...overrides,
  };
}

function memory(types: readonly FeedbackEventType[], projectionOverrides = {}): ApplicationMemory {
  const record = makeApplication({ id: 'app-1' });
  const events = types.map((eventType, index) => makeEvent(eventType, {
    id: `event-${index}`, applicationId: record.id, idempotencyKey: `key-${index}`,
    eventAt: 1_000 + index * 100, createdAt: 1_000 + index * 100,
  }));
  return {
    record, events,
    projection: { ...projectApplication(record, events), ...projectionOverrides },
  };
}

function applicationFacts(current: ApplicationMemory, jobOverrides: Partial<JobRecord> = {}): DecisionOpportunityFacts {
  return resolveDecisionOpportunityFacts({
    job: job(jobOverrides), selectedApplication: current, defaultApplication: current,
    availableApplications: [current], jobMemoryV2Enabled: true,
  });
}

describe('deriveDecision ApplicationProjection', () => {
  it.each([
    [['hr_replied'], 'continue_conversation'],
    [['interview_scheduled'], 'prepare_interview'],
    [['recruitment_paused'], 'pause_watch'],
    [['offer_received'], 'continue_conversation'],
  ] as const)('%j 映射为 %s', (events, nextAction) => {
    expect(deriveDecision(applicationFacts(memory(events))).nextAction).toBe(nextAction);
  });

  it('cooldown 和 follow-up count 只读取 Projection 稳定字段', () => {
    const greeted = memory(['greeting_sent']);
    const availableAt = greeted.projection.nextAllowedFollowUpAt!;
    expect(availableAt).toBe(1_000 + FOLLOWUP_COOLDOWN_DAYS * DAY);
    expect(deriveDecision(applicationFacts(greeted, {
      communicationStatus: 'rejected', followupCount: 99, lastGreetedAt: 99,
    }), { now: availableAt - 1 }).nextAction).toBe('wait');
    expect(deriveDecision(applicationFacts(greeted, {
      communicationStatus: 'rejected', followupCount: 99, lastGreetedAt: 99,
    }), { now: availableAt }).nextAction).toBe('follow_up_once');

    const once = memory(['greeting_sent', 'follow_up_sent']);
    expect(once.projection.followUpCount).toBe(1);
    expect(deriveDecision(applicationFacts(once), {
      now: once.projection.nextAllowedFollowUpAt!,
    }).nextAction).toBe('follow_up_with_new_angle');
    const twice = memory(['greeting_sent', 'follow_up_sent', 'follow_up_sent']);
    expect(deriveDecision(applicationFacts(twice), { now: Number.MAX_SAFE_INTEGER })).toMatchObject({
      nextAction: 'close_opportunity', stopLoss: true,
    });
  });

  it('message viewed、no-response 与 rejection 保持不同语义', () => {
    const viewed = memory(['greeting_sent', 'message_viewed']);
    expect(deriveDecision(applicationFacts(viewed), { now: 0 }).nextAction)
      .toBe('follow_up_with_new_angle');
    const noResponse = memory(['greeting_sent', 'no_response_recorded']);
    expect(noResponse.projection.outcome).toBeNull();
    expect(deriveDecision(applicationFacts(noResponse), { now: 0 }).flowNotice).toBeUndefined();
    const rejected = deriveDecision(applicationFacts(memory(['rejected'])));
    expect(rejected).toMatchObject({ nextAction: null, flowNotice: expect.stringContaining('拒绝') });
  });

  it.each([
    ['user_withdrew', '主动退出'],
    ['position_closed', '岗位已关闭'],
    ['marked_stale', '失效'],
    ['offer_declined', '拒绝该 Offer'],
    ['offer_accepted', '成功结束'],
  ] as const)('%s 保留精确 outcome 文案且不继续跟进', (eventType, notice) => {
    const decision = deriveDecision(applicationFacts(memory([eventType])));
    expect(decision.nextAction).toBeNull();
    expect(decision.flowNotice).toContain(notice);
  });

  it('invalid 不回退 legacy 且阻止普通动作，degraded 继续保守建议', () => {
    const invalid = memory(['greeting_sent']);
    invalid.projection = {
      ...invalid.projection, projectionStatus: 'invalid',
      errors: [{ code: 'INVALID_PROJECTION_OUTPUT', message: 'broken' }],
    };
    expect(deriveDecision(applicationFacts(invalid, { communicationStatus: 'replied' }))).toMatchObject({
      nextAction: 'manual_review', flowNotice: expect.stringContaining('无法安全计算'),
    });

    const degraded = memory(['process_resumed']);
    expect(degraded.projection.projectionStatus).toBe('degraded');
    expect(deriveDecision(applicationFacts(degraded)).nextAction).toBe('send_greeting');
  });

  it('opportunity-only 只做岗位级建议，legacy adapter 保持旧结果', () => {
    const opportunity = resolveDecisionOpportunityFacts({
      job: job(), selectedApplication: null, defaultApplication: null, jobMemoryV2Enabled: true,
    });
    expect(opportunity.source).toBe('opportunity_only');
    expect(deriveDecision(opportunity).nextAction).toBe('send_greeting');
    expect(deriveDecision(opportunity).flowNotice).toBeUndefined();
    expect(deriveLegacyDecision(job({
      communicationStatus: 'greeted_unread', lastGreetedAt: 1_000,
    }), undefined, 1_000 + 3 * DAY).nextAction).toBe('follow_up_once');
  });
});

describe('company warning trusted facts', () => {
  it('active/replied Application 触发提示，opportunity-only、voided 和 invalid 不产生肯定 warning', () => {
    const current = resolveDecisionOpportunityFacts({
      job: job({ id: 'current', report: { ...job().report!, applyAdvice: 'cautious' } }),
      selectedApplication: null, defaultApplication: null, jobMemoryV2Enabled: true,
    });
    const replied = applicationFacts(memory(['hr_replied']), { id: 'replied' });
    expect(deriveCompanyWarning(current, [current, replied])).toContain('进入沟通或面试');

    const noFlow = resolveDecisionOpportunityFacts({
      job: job({ id: 'no-flow' }), selectedApplication: null, defaultApplication: null,
      jobMemoryV2Enabled: true,
    });
    expect(deriveCompanyWarning(current, [current, noFlow])).toBeUndefined();

    const invalidMemory = memory(['hr_replied']);
    invalidMemory.projection = {
      ...invalidMemory.projection, projectionStatus: 'invalid',
      errors: [{ code: 'INVALID_PROJECTION_OUTPUT', message: 'broken' }],
    };
    const invalid = applicationFacts(invalidMemory, { id: 'invalid' });
    expect(deriveCompanyWarning(current, [current, invalid])).toBeUndefined();
  });

  it('零 Application meaningful legacy 仍作为只读兼容来源', () => {
    const current = resolveDecisionOpportunityFacts({
      job: job({ id: 'current', report: { ...job().report!, applyAdvice: 'cautious' } }),
      selectedApplication: null, defaultApplication: null, jobMemoryV2Enabled: true,
    });
    const legacy = resolveDecisionOpportunityFacts({
      job: job({ id: 'legacy', communicationStatus: 'interviewing' }),
      selectedApplication: null, defaultApplication: null, jobMemoryV2Enabled: true,
    });
    expect(legacy.source).toBe('legacy_job_fallback');
    expect(deriveCompanyWarning(current, [current, legacy])).toContain('进入沟通或面试');
  });
});

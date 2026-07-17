import { describe, expect, it } from 'vitest';
import { emptyCompanyInput, type JobRecord } from '../storage';
import { makeApplication, makeEvent } from '../domain/job-memory/testFixtures';
import { projectApplication, type ApplicationMemory } from '../domain/job-memory';
import {
  assertDecisionOpportunityFacts,
  hasMeaningfulLegacyCommunication,
  legacyCommunicationFacts,
  resolveDecisionOpportunityFacts,
  type DecisionOpportunityFacts,
} from './decisionOpportunityFacts';

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: 'job-1', createdAt: 1, updatedAt: 1, company: '测试公司', role: '前端', city: '苏州',
    salaryRange: '', jdText: '', promptText: '', aiRawResult: '', aiPastedAt: null,
    parseStatus: 'none', report: null, matchScore: '', companyInput: emptyCompanyInput(),
    companyAssessment: null, opportunityAnalysis: null, communicationStatus: 'not_contacted',
    followupCount: 0, ...overrides,
  };
}

function application(
  id: string,
  eventType: 'greeting_sent' | 'hr_replied' = 'greeting_sent',
  overrides = {},
): ApplicationMemory {
  const record = makeApplication({ id, ...overrides });
  const event = makeEvent(eventType, { id: `${id}-event`, applicationId: id, idempotencyKey: `${id}-key` });
  return { record, events: [event], projection: projectApplication(record, [event]) };
}

describe('DecisionOpportunityFacts 来源选择', () => {
  it('v1 始终使用 legacy，即使传入 Application', () => {
    const selected = application('selected');
    const facts = resolveDecisionOpportunityFacts({
      job: job({ communicationStatus: 'replied' }), selectedApplication: selected,
      defaultApplication: selected, availableApplications: [selected], jobMemoryV2Enabled: false,
    });
    expect(facts).toMatchObject({
      source: 'legacy_job_fallback', application: null,
      legacyCommunication: { communicationStatus: 'replied' },
    });
  });

  it('v2 按 selected、default、可用 invalid Application 的顺序选择且不携带 legacy', () => {
    const selected = application('selected', 'hr_replied');
    const fallback = application('default');
    const selectedFacts = resolveDecisionOpportunityFacts({
      job: job({ communicationStatus: 'rejected', followupCount: 9 }),
      selectedApplication: selected, defaultApplication: fallback,
      availableApplications: [selected, fallback], jobMemoryV2Enabled: true,
    });
    expect(selectedFacts).toMatchObject({
      source: 'application_projection', application: { applicationId: 'selected' },
      legacyCommunication: null,
    });

    const defaultFacts = resolveDecisionOpportunityFacts({
      job: job(), selectedApplication: null, defaultApplication: fallback,
      availableApplications: [fallback], jobMemoryV2Enabled: true,
    });
    expect(defaultFacts.application?.applicationId).toBe('default');

    const invalid = application('invalid');
    invalid.projection = {
      ...invalid.projection,
      projectionStatus: 'invalid',
      errors: [{ code: 'INVALID_PROJECTION_OUTPUT', message: 'broken' }],
    };
    const invalidFacts = resolveDecisionOpportunityFacts({
      job: job({ communicationStatus: 'replied' }), selectedApplication: null,
      defaultApplication: null, availableApplications: [invalid], jobMemoryV2Enabled: true,
    });
    expect(invalidFacts).toMatchObject({
      source: 'application_projection', application: { applicationId: 'invalid' },
    });
  });

  it('v2 零 Application 只在旧事实有意义时 fallback，否则 opportunity-only', () => {
    const meaningfulJobs = [
      job({ communicationStatus: 'paused' }),
      job({ followupCount: 1 }),
      job({ lastGreetedAt: 2 }),
      job({ lastFollowupAt: 3 }),
      job({ lastCommunicationNote: '历史备注' }),
    ];
    for (const candidate of meaningfulJobs) {
      expect(hasMeaningfulLegacyCommunication(legacyCommunicationFacts(candidate))).toBe(true);
      expect(resolveDecisionOpportunityFacts({
        job: candidate, selectedApplication: null, defaultApplication: null,
        jobMemoryV2Enabled: true,
      }).source).toBe('legacy_job_fallback');
    }
    expect(resolveDecisionOpportunityFacts({
      job: job({ lastCommunicationNote: '   ' }), selectedApplication: null,
      defaultApplication: null, jobMemoryV2Enabled: true,
    })).toMatchObject({ source: 'opportunity_only', application: null, legacyCommunication: null });
  });

  it('已作废 Application 不进入决策输入', () => {
    const voided = application('voided', 'greeting_sent', { voidedAt: 10, voidReason: '误录' });
    expect(resolveDecisionOpportunityFacts({
      job: job(), selectedApplication: voided, defaultApplication: voided,
      availableApplications: [voided], jobMemoryV2Enabled: true,
    }).source).toBe('opportunity_only');
  });

  it('runtime assertion 拒绝 source 与 payload 非法组合及 voided projection', () => {
    const badLegacy = {
      source: 'legacy_job_fallback', job: job(), application: { applicationId: 'x' },
      legacyCommunication: null,
    } as unknown as DecisionOpportunityFacts;
    expect(() => assertDecisionOpportunityFacts(badLegacy)).toThrow(/legacy_job_fallback/);

    const selected = application('void-projection');
    const badApplication = {
      source: 'application_projection', job: job(), legacyCommunication: null,
      application: {
        applicationId: selected.record.id,
        projection: {
          ...selected.projection, stage: 'closed', outcome: null, communicationStatus: 'closed',
          isClosed: true, isVoided: true, statusSourceEventId: null,
        },
      },
    } as DecisionOpportunityFacts;
    expect(() => assertDecisionOpportunityFacts(badApplication)).toThrow(/已作废/);
  });
});

import { describe, expect, it } from 'vitest';
import { selectRuntimeWriter } from './writerSelectionPolicy';
import type { WriterRuntimeCandidate } from './writerRuntimeCandidatePool';

function candidate(profileId: string, logicalModelName = `${profileId}-model`): WriterRuntimeCandidate {
  return {
    profileId,
    logicalModelName,
    providerIdentifier: profileId,
    certificateId: null,
    resultId: null,
    batchId: null,
    qualificationIdentityFingerprint: null,
    pricingReady: true,
  };
}

describe('Writer Selection Policy v1', () => {
  it('fails closed with 0 candidates (A)', () => {
    expect(selectRuntimeWriter([])).toEqual({ status: 'NO_ELIGIBLE_WRITER' });
  });

  it('deterministically selects the single candidate (B)', () => {
    const only = candidate('grok-writer');
    expect(selectRuntimeWriter([only])).toEqual({ status: 'SELECTED', candidate: only });
  });

  it('fails closed ambiguous with 2 candidates and no preference (C)', () => {
    const result = selectRuntimeWriter([candidate('a'), candidate('b')]);
    expect(result.status).toBe('AMBIGUOUS_ELIGIBLE_WRITERS');
    if (result.status === 'AMBIGUOUS_ELIGIBLE_WRITERS') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it('selects with an explicit valid preference (D)', () => {
    const a = candidate('writer-a');
    const b = candidate('writer-b');
    expect(selectRuntimeWriter([a, b], { profileId: 'writer-b' })).toEqual({
      status: 'SELECTED',
      candidate: b,
    });
  });

  it('rejects a preference that points to an ineligible/absent candidate (E)', () => {
    const a = candidate('writer-a');
    expect(selectRuntimeWriter([a], { profileId: 'writer-missing' })).toEqual({
      status: 'PREFERENCE_NOT_ELIGIBLE',
      preferenceProfileId: 'writer-missing',
    });
  });

  it('matches by logicalModelName preference as well', () => {
    const a = candidate('writer-a', 'model-a');
    const b = candidate('writer-b', 'model-b');
    expect(selectRuntimeWriter([a, b], { logicalModelName: 'model-a' })).toEqual({
      status: 'SELECTED',
      candidate: a,
    });
  });

  it('does not consult provider brand in selection', () => {
    const grok = candidate('apikey-grok-4-6', 'grok-4-6-writer');
    const deepseek = candidate('deepseek-v4-pro', 'deepseek-v4-pro');
    // Order irrelevant: without preference the policy is brand-agnostic and ambiguous.
    const result = selectRuntimeWriter([deepseek, grok]);
    expect(result.status).toBe('AMBIGUOUS_ELIGIBLE_WRITERS');
  });
});

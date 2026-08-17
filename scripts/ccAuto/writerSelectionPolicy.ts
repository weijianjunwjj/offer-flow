/**
 * Writer Selection Policy v1 — deterministic, explicit, brand-free.
 *
 * Chooses one Runtime Writer from the eligible candidate pool. There is no
 * AI router, no brand ordering, and no capability scoring. Qualification is a
 * gate, not a leaderboard.
 */
import type { WriterRuntimeCandidate } from './writerRuntimeCandidatePool';

export interface WriterSelectionPreference {
  profileId?: string;
  logicalModelName?: string;
}

export type WriterSelectionResult =
  | { status: 'SELECTED'; candidate: WriterRuntimeCandidate }
  | { status: 'NO_ELIGIBLE_WRITER' }
  | { status: 'AMBIGUOUS_ELIGIBLE_WRITERS'; candidates: WriterRuntimeCandidate[] }
  | { status: 'PREFERENCE_NOT_ELIGIBLE'; preferenceProfileId: string };

function matchesPreference(
  candidate: WriterRuntimeCandidate,
  preference: WriterSelectionPreference,
): boolean {
  if (preference.profileId !== undefined && preference.profileId !== candidate.profileId) {
    return false;
  }
  if (preference.logicalModelName !== undefined
    && preference.logicalModelName !== candidate.logicalModelName) {
    return false;
  }
  return preference.profileId !== undefined || preference.logicalModelName !== undefined;
}

/**
 * Selects the Runtime Writer deterministically:
 *   0 candidates               → fail closed (NO_ELIGIBLE_WRITER)
 *   1 candidate                → SELECTED
 *   >1 candidates, no pref     → AMBIGUOUS_ELIGIBLE_WRITERS (fail closed)
 *   >1 candidates, valid pref  → SELECTED
 *   pref → ineligible/absent   → PREFERENCE_NOT_ELIGIBLE (reject)
 */
export function selectRuntimeWriter(
  candidates: readonly WriterRuntimeCandidate[],
  preference?: WriterSelectionPreference | null,
): WriterSelectionResult {
  if (candidates.length === 0) {
    return { status: 'NO_ELIGIBLE_WRITER' };
  }

  if (preference && (preference.profileId !== undefined || preference.logicalModelName !== undefined)) {
    const matches = candidates.filter((candidate) => matchesPreference(candidate, preference));
    if (matches.length === 1) {
      return { status: 'SELECTED', candidate: matches[0] };
    }
    if (matches.length > 1) {
      return { status: 'AMBIGUOUS_ELIGIBLE_WRITERS', candidates: matches };
    }
    return {
      status: 'PREFERENCE_NOT_ELIGIBLE',
      preferenceProfileId: preference.profileId ?? preference.logicalModelName ?? '',
    };
  }

  if (candidates.length === 1) {
    return { status: 'SELECTED', candidate: candidates[0] };
  }

  return { status: 'AMBIGUOUS_ELIGIBLE_WRITERS', candidates: [...candidates] };
}

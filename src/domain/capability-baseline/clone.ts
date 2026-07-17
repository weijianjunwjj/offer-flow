import {
  CandidateEvidenceContentSchema,
  CapabilityBaselineDraftSchema,
} from './schemas';
import type { CandidateEvidenceContent, CapabilityBaselineDraft } from './types';

export function cloneCapabilityBaselineDraft(
  value: CapabilityBaselineDraft,
): CapabilityBaselineDraft {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return CapabilityBaselineDraftSchema.parse(plain);
}

export function cloneCandidateEvidenceContent(
  value: CandidateEvidenceContent,
): CandidateEvidenceContent {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return CandidateEvidenceContentSchema.parse(plain);
}

import { JobMatchProfileDraftSchema } from './schemas';
import type { JobMatchProfileDraft } from './types';

export function cloneJobMatchProfileDraft(value: JobMatchProfileDraft): JobMatchProfileDraft {
  const plain: unknown = JSON.parse(JSON.stringify(value));
  return JobMatchProfileDraftSchema.parse(plain);
}

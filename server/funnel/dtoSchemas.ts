import { z } from 'zod';
import { ApplicationChannelSchema } from '../../src/domain/job-memory/schemas';
import { FUNNEL_TIME_GRANULARITIES } from '../../src/domain/funnel';

const trimmedString = z.string().trim().min(1);
const timestamp = z.coerce.number().int().min(0);

export const FunnelQueryParamsSchema = z.strictObject({
  city: trimmedString.optional(),
  roleFamily: trimmedString.optional(),
  channel: ApplicationChannelSchema.optional(),
  resumeVersionId: trimmedString.optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
  timeGranularity: z.enum(FUNNEL_TIME_GRANULARITIES).optional(),
}).superRefine((value, ctx) => {
  if (value.from !== undefined && value.to !== undefined && value.to <= value.from) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'to 必须晚于 from' });
  }
});

export type FunnelQueryParams = z.infer<typeof FunnelQueryParamsSchema>;

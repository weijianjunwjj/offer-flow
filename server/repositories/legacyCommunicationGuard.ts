import type { JobRecord } from '../../src/storage';

export const LEGACY_COMMUNICATION_WRITE_DISABLED = 'LEGACY_COMMUNICATION_WRITE_DISABLED';

export const LEGACY_COMMUNICATION_FIELDS = [
  'communicationStatus',
  'followupCount',
  'lastGreetedAt',
  'lastFollowupAt',
  'lastCommunicationNote',
] as const satisfies readonly (keyof JobRecord)[];

export class LegacyCommunicationWriteError extends Error {
  readonly statusCode = 422;
  readonly code = LEGACY_COMMUNICATION_WRITE_DISABLED;

  constructor(readonly fields: readonly string[]) {
    super(`Job Memory v2 已禁用旧沟通事实写入：${fields.join(', ')}`);
    this.name = 'LegacyCommunicationWriteError';
  }

  toBody(): { code: string; message: string; fieldErrors: Record<string, string[]> } {
    return {
      code: this.code,
      message: 'Job Memory v2 模式下，流程事实必须通过 Application 和 FeedbackEvent 维护',
      fieldErrors: Object.fromEntries(this.fields.map((field) => [
        field,
        ['该字段在 v2 模式下只读'],
      ])),
    };
  }
}

function optionalValue(value: unknown): unknown {
  return value === undefined || value === null || value === '' ? null : value;
}

export function changedLegacyFields(current: JobRecord, next: JobRecord): string[] {
  return LEGACY_COMMUNICATION_FIELDS.filter((field) => (
    optionalValue(current[field]) !== optionalValue(next[field])
  ));
}

export function nonDefaultLegacyFields(job: JobRecord): string[] {
  const fields: string[] = [];
  if (job.communicationStatus !== 'not_contacted') fields.push('communicationStatus');
  if (job.followupCount !== 0) fields.push('followupCount');
  if (optionalValue(job.lastGreetedAt) !== null) fields.push('lastGreetedAt');
  if (optionalValue(job.lastFollowupAt) !== null) fields.push('lastFollowupAt');
  if (optionalValue(job.lastCommunicationNote) !== null) fields.push('lastCommunicationNote');
  return fields;
}

export function legacyFieldsPresent(patch: object): string[] {
  return LEGACY_COMMUNICATION_FIELDS.filter((field) => (
    Object.prototype.hasOwnProperty.call(patch, field)
  ));
}

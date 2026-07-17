import type {
  ApplicationCorrectableField,
  ApplicationCorrectableSnapshot,
  ApplicationRecord,
} from '../../src/domain/job-memory';
import type { UpdateApplicationMetadataRequest } from './dtoSchemas';
import { canonicalJson } from './requestHash';

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function mergeApplicationMetadata(
  current: ApplicationRecord,
  request: UpdateApplicationMetadataRequest,
): ApplicationRecord {
  return {
    ...current,
    resumeVersionId: request.resumeVersionId === undefined
      ? current.resumeVersionId
      : request.resumeVersionId,
    channel: request.channel ?? current.channel,
    channelOtherLabel: request.channelOtherLabel === undefined
      ? current.channelOtherLabel
      : request.channelOtherLabel,
    recruitingEntity: request.recruitingEntity ?? current.recruitingEntity,
    primaryContact: request.primaryContact === undefined
      ? current.primaryContact
      : request.primaryContact,
    cityContext: request.cityContext ?? current.cityContext,
    draftMessageText: request.draftMessageText === undefined
      ? current.draftMessageText
      : request.draftMessageText,
  };
}

export function changedApplicationFields(
  current: ApplicationRecord,
  next: ApplicationRecord,
): {
  correctedFields: ApplicationCorrectableField[];
  before: ApplicationCorrectableSnapshot;
  after: ApplicationCorrectableSnapshot;
} {
  const correctedFields: ApplicationCorrectableField[] = [];
  const before: ApplicationCorrectableSnapshot = {};
  const after: ApplicationCorrectableSnapshot = {};
  if (!sameValue(current.resumeVersionId, next.resumeVersionId)) {
    correctedFields.push('resumeVersionId');
    before.resumeVersionId = current.resumeVersionId;
    after.resumeVersionId = next.resumeVersionId;
  }
  if (!sameValue(current.channel, next.channel)) {
    correctedFields.push('channel');
    before.channel = current.channel;
    after.channel = next.channel;
  }
  if (!sameValue(current.channelOtherLabel, next.channelOtherLabel)) {
    correctedFields.push('channelOtherLabel');
    before.channelOtherLabel = current.channelOtherLabel;
    after.channelOtherLabel = next.channelOtherLabel;
  }
  if (!sameValue(current.recruitingEntity, next.recruitingEntity)) {
    correctedFields.push('recruitingEntity');
    before.recruitingEntity = current.recruitingEntity;
    after.recruitingEntity = next.recruitingEntity;
  }
  if (!sameValue(current.primaryContact, next.primaryContact)) {
    correctedFields.push('primaryContact');
    before.primaryContact = current.primaryContact;
    after.primaryContact = next.primaryContact;
  }
  if (!sameValue(current.cityContext, next.cityContext)) {
    correctedFields.push('cityContext');
    before.cityContext = current.cityContext;
    after.cityContext = next.cityContext;
  }
  if (!sameValue(current.draftMessageText, next.draftMessageText)) {
    correctedFields.push('draftMessageText');
    before.draftMessageText = current.draftMessageText;
    after.draftMessageText = next.draftMessageText;
  }
  return { correctedFields, before, after };
}

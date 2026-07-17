import { describe, expect, it } from 'vitest';
import { FEEDBACK_EVENT_TYPES } from '../job-memory/types';
import {
  APPLICATION_CHANNEL_LABELS,
  APPLICATION_ORIGIN_LABELS,
  APPLICATION_OUTCOME_LABELS,
  APPLICATION_STAGE_LABELS,
  COMMUNICATION_STATUS_LABELS,
  CONTACT_ROLE_LABELS,
  EVIDENCE_LEVEL_LABELS,
  FEEDBACK_ACTOR_LABELS,
  FEEDBACK_EVENT_TYPE_LABELS,
  FEEDBACK_RECORDED_BY_LABELS,
  IMPORT_STATUS_LABELS,
  IMPORTED_RECOMMENDATION_LABELS,
  PARSE_STATUS_LABELS,
  PROJECTION_STATUS_LABELS,
  RECRUITING_ENTITY_KIND_LABELS,
  RESUME_VERSION_SOURCE_LABELS,
  REVIEW_STATUS_LABELS,
  SOURCE_CONFIDENCE_LABELS,
  SUBMISSION_STATE_LABELS,
  TIME_PRECISION_LABELS,
  WORK_MODE_LABELS,
  formatApplicationChannelLabel,
  formatApplicationOutcomeLabel,
  formatFeedbackEventTypeLabel,
  formatReasonCodeLabel,
} from './jobMemoryLabels';

const officialMaps = [
  APPLICATION_STAGE_LABELS,
  APPLICATION_OUTCOME_LABELS,
  COMMUNICATION_STATUS_LABELS,
  PROJECTION_STATUS_LABELS,
  FEEDBACK_EVENT_TYPE_LABELS,
  APPLICATION_ORIGIN_LABELS,
  APPLICATION_CHANNEL_LABELS,
  RECRUITING_ENTITY_KIND_LABELS,
  CONTACT_ROLE_LABELS,
  FEEDBACK_ACTOR_LABELS,
  FEEDBACK_RECORDED_BY_LABELS,
  IMPORT_STATUS_LABELS,
  REVIEW_STATUS_LABELS,
  PARSE_STATUS_LABELS,
  IMPORTED_RECOMMENDATION_LABELS,
  SOURCE_CONFIDENCE_LABELS,
  EVIDENCE_LEVEL_LABELS,
  TIME_PRECISION_LABELS,
  WORK_MODE_LABELS,
  RESUME_VERSION_SOURCE_LABELS,
  SUBMISSION_STATE_LABELS,
] as const;

describe('jobMemoryLabels', () => {
  it('为全部正式枚举提供非空中文标签', () => {
    for (const labels of officialMaps) {
      for (const [code, label] of Object.entries(labels)) {
        expect(label, code).toMatch(/[\u4e00-\u9fff]/);
        expect(label).not.toBe(code);
      }
    }
    expect(Object.keys(FEEDBACK_EVENT_TYPE_LABELS)).toEqual([...FEEDBACK_EVENT_TYPES]);
  });

  it('处理空结果、自定义渠道与未知服务端值，不把原始 code 暴露到主展示', () => {
    expect(formatApplicationOutcomeLabel(null)).toBe('暂无结果');
    expect(formatApplicationChannelLabel('other', '线下活动')).toBe('线下活动');
    expect(formatApplicationChannelLabel('future_channel')).toBe('未知渠道');
    expect(formatFeedbackEventTypeLabel('future_event')).toBe('未知状态');
    expect(formatReasonCodeLabel('future_reason')).toBe('未知原因');
    expect(formatReasonCodeLabel(null)).toBe('未记录原因');
  });
});

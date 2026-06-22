// 沟通状态的中文标签与可选项（单一信源）。
// 状态枚举与顺序对应 DEC-020：v0.3 半自动跟进决策台的 8 态沟通事实。
import type { CommunicationStatus } from '../storage';

export interface CommunicationStatusOption {
  value: CommunicationStatus;
  label: string;
}

export const COMMUNICATION_STATUS_OPTIONS: ReadonlyArray<CommunicationStatusOption> = [
  { value: 'not_contacted', label: '未沟通' },
  { value: 'greeted_unread', label: '已打招呼（未读）' },
  { value: 'greeted_read_no_reply', label: '已读未回' },
  { value: 'replied', label: '已回复' },
  { value: 'interviewing', label: '面试推进中' },
  { value: 'paused', label: '暂停观察' },
  { value: 'closed', label: '已结束' },
  { value: 'rejected', label: '已拒绝' },
];

export const COMMUNICATION_STATUS_LABELS: Record<CommunicationStatus, string> =
  Object.fromEntries(
    COMMUNICATION_STATUS_OPTIONS.map((option) => [option.value, option.label]),
  ) as Record<CommunicationStatus, string>;

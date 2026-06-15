// 沟通状态的中文标签与可选项（单一信源）。
// 状态枚举与顺序对应 DEC-003：未沟通 / 已打招呼 / 已回复 / 已约面 / 已拒绝 / 已结束。
import type { ContactStatus } from '../storage';

export interface ContactStatusOption {
  value: ContactStatus;
  label: string;
}

export const CONTACT_STATUS_OPTIONS: ReadonlyArray<ContactStatusOption> = [
  { value: 'not_contacted', label: '未沟通' },
  { value: 'greeted', label: '已打招呼' },
  { value: 'replied', label: '已回复' },
  { value: 'interview_scheduled', label: '已约面' },
  { value: 'rejected', label: '已拒绝' },
  { value: 'closed', label: '已结束' },
];

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> =
  Object.fromEntries(
    CONTACT_STATUS_OPTIONS.map((option) => [option.value, option.label]),
  ) as Record<ContactStatus, string>;

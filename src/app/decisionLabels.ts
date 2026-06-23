import type { NextActionType } from '../decision';
import type { StrategyType } from '../storage';

export const STRATEGY_LABELS: Record<StrategyType, string> = {
  main_attack: '主攻',
  low_cost_probe: '低成本试探',
  cautious_watch: '谨慎观察',
  cut_loss: '止损',
};

export const NEXT_ACTION_LABELS: Record<NextActionType, string> = {
  send_greeting: '待打招呼',
  wait: '等回复',
  follow_up_once: '可跟进',
  follow_up_with_new_angle: '换角度跟进',
  close_opportunity: '关闭机会',
  continue_conversation: '继续沟通',
  prepare_interview: '准备面试',
  pause_watch: '暂停观察',
};

export function nextActionLabel(action: NextActionType | null): string {
  return action === null ? '已结束' : NEXT_ACTION_LABELS[action];
}

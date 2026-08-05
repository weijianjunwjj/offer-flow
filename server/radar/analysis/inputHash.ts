/**
 * V8-4 单岗位分析确定性幂等键 · 纯函数（不读数据库、不建 AnalysisTask）。
 *
 * - inputHash = sha256(canonicalJson(snapshot 去掉 createdAt))，前缀 job-match-analysis-input:v1；
 * - createdAt 不进入 hash（同语义快照同 hash）；
 * - 正式内容 / 版本 / Provider policy / model 变化 → 不同 hash；
 * - task.id = analysis-task:v1:<64 位小写 sha256>。
 */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../job-memory/requestHash';
import type { JobMatchAnalysisInputSnapshot } from './contracts';

export const ANALYSIS_INPUT_HASH_PREFIX = 'job-match-analysis-input:v1';
export const ANALYSIS_TASK_ID_PREFIX = 'analysis-task:v1';

/** 64 位小写十六进制 sha256。 */
const SHA256_HEX = /^[0-9a-f]{64}$/;
export const ANALYSIS_TASK_ID_PATTERN = /^analysis-task:v1:[0-9a-f]{64}$/;

/**
 * 计算输入快照的确定性 inputHash。
 * createdAt 被显式剔除后再 canonical 序列化，因此仅创建时间不同的两份语义相同快照 hash 相同。
 */
export function buildJobMatchAnalysisInputHash(snapshot: JobMatchAnalysisInputSnapshot): string {
  const { createdAt: _ignored, ...semantic } = snapshot;
  const canonical = canonicalJson(semantic);
  return createHash('sha256').update(`${ANALYSIS_INPUT_HASH_PREFIX}\n${canonical}`).digest('hex');
}

/** 由 inputHash 构造确定性 task.id，严格校验 hash 为 64 位小写 sha256。 */
export function buildJobMatchAnalysisTaskId(inputHash: string): string {
  if (!SHA256_HEX.test(inputHash)) {
    throw new TypeError('inputHash 必须是 64 位小写十六进制 sha256');
  }
  return `${ANALYSIS_TASK_ID_PREFIX}:${inputHash}`;
}

/** 校验字符串是否为合法的确定性分析任务 ID。 */
export function isAnalysisTaskId(value: string): boolean {
  return ANALYSIS_TASK_ID_PATTERN.test(value);
}

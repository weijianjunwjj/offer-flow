/**
 * better-sqlite3 的 UNIQUE / PRIMARY KEY 约束违反识别。
 *
 * 供「历史版本回退（historical version reactivation）」的并发兜底使用：
 *   只用于在 INSERT CandidateVersion 命中 UNIQUE(candidate_id, content_hash) 竞争时，
 *   重读已存在版本并复用；其余约束错误（FK、其它 UNIQUE、DB 错误）一律继续抛出。
 *
 * 注意：本函数只回答「是否属于约束违反」，不判断具体是哪一条约束；
 * 调用方必须再按 (candidate_id, content_hash) 重读，仅在命中原 hash 时才视为幂等竞争。
 */
export function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return true;
  return /UNIQUE constraint failed/i.test(error.message);
}

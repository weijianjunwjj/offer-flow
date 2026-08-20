import type { SqliteDatabase } from '../db';
import { SourceRunRepository } from './sourceRunRepository';

/**
 * OfferFlow v0.9 — Orphan SourceRun 启动协调。
 *
 * 问题：用户 kill backend 后，RUNNING / PENDING 状态的 SourceRun 会残留，
 * 阻塞新 run-now 请求（UNIQUE 约束 on search_plan_id + scheduled_day WHERE 非终态）。
 *
 * 解决：backend 成功监听端口后，自动将上一进程遗留的 PENDING / RUNNING 转为 INTERRUPTED。
 *
 * 设计约束：
 *   - 必须通过 SourceRunRepository.transitionStatus，不绕过状态机；
 *   - PENDING / RUNNING → INTERRUPTED（合法转移）；
 *   - WAITING_FOR_USER 是跨进程业务状态，不自动清理；
 *   - 终态（SUCCEEDED / FAILED / PARTIALLY_SUCCEEDED / CANCELLED / INTERRUPTED）不修改；
 *   - 幂等：重复执行无副作用；
 *   - 不删除历史、不伪造 DailyBrief、不触发 Pipeline / Tavily / LLM。
 *
 * 触发时机：Fastify onListen（成功监听端口后），避免第二个进程因 EADDRINUSE 失败
 * 却提前把第一个正常进程的 RUNNING 误标为 INTERRUPTED。
 */

/** 查询遗留的非终态 orphan runs（PENDING / RUNNING，不含 WAITING_FOR_USER）。 */
function findOrphanRuns(db: SqliteDatabase): Array<{ id: string; status: string }> {
  const rows = db
    .prepare(`
      SELECT id, status
      FROM source_runs
      WHERE status IN ('PENDING', 'RUNNING')
        AND finished_at IS NULL
      ORDER BY created_at ASC
    `)
    .all() as Array<{ id: string; status: string }>;
  return rows;
}

/**
 * 协调上一进程遗留的 orphan SourceRun。
 *
 * 将 PENDING / RUNNING 状态、finished_at IS NULL 的运行转为 INTERRUPTED，
 * 标记 error_code='PROCESS_RESTART'。
 *
 * 幂等：已处于终态的运行不受影响；重复调用不产生副作用。
 */
export function reconcileOrphanSourceRuns(db: SqliteDatabase): void {
  const repo = new SourceRunRepository(db);
  const orphans = findOrphanRuns(db);

  for (const orphan of orphans) {
    try {
      repo.transitionStatus(orphan.id, {
        toStatus: 'INTERRUPTED',
        errorCode: 'PROCESS_RESTART',
        errorMessage: 'Process terminated before completion',
      });
    } catch (error) {
      // 单个 orphan transition 失败不终止整体协调（防御性容错）。
      // 日志暂时静默（生产环境可补充日志框架）。
      console.error(`Failed to reconcile orphan SourceRun ${orphan.id}:`, error);
    }
  }
}
